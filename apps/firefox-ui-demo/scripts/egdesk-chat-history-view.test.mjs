import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import * as View from '../overlay/resources/EGDeskChatHistoryView.sys.mjs';

const source = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
const declaration = (name) => {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf('\n  }\n', start);
  assert.ok(start >= 0 && end > start, `production function: ${name}`);
  return source.slice(start, end + 5);
};
const between = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `production block: ${start.trim()}`);
  return source.slice(a, b);
};
const el = (tag, props = {}, ...children) => ({ tag, props, className: props.class, dataset: { ...props.data }, children: children.filter(child => child != null) });
const formatTime = (at) => {
  const date = new Date(at);
  return `${date.getHours() < 12 ? '오전' : '오후'} ${date.getHours() % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')}`;
};
// Local times, so the expectations hold in any time zone.
const at = (year, month, day, hour = 9, minute = 41) => new Date(year, month - 1, day, hour, minute).getTime();
const NOW = at(2026, 11, 14, 15, 0);

test('the day line names today with its first time, yesterday, and older days by date', () => {
  assert.equal(View.dayLabel(at(2026, 11, 14), NOW, { formatTime }), '오늘 · 오전 9:41');
  assert.equal(View.dayLabel(at(2026, 11, 14, 13, 5), NOW), '오늘 · 오후 1:05', 'the module formats the time when the surface passes none');
  assert.equal(View.dayLabel(at(2026, 11, 13, 23, 59), NOW, { formatTime }), '어제');
  assert.equal(View.dayLabel(at(2026, 11, 12), NOW, { formatTime }), '11월 12일');
  assert.equal(View.dayLabel(at(2025, 12, 31), NOW, { formatTime }), '2025년 12월 31일');
  assert.equal(View.dayLabel(at(2026, 10, 31), at(2026, 11, 1, 0, 5), { formatTime }), '어제', 'yesterday crosses a month boundary');
  assert.equal(View.dayLabel(null, NOW), '');
  assert.equal(View.dayLabel(Number.NaN, NOW), '');
});

test('a day line opens the conversation and every change of date, and nothing else', () => {
  const first = View.dayDivider(null, at(2026, 11, 13, 22, 0), NOW, { formatTime });
  assert.deepEqual(first, { key: '2026-11-13', label: '어제' });
  assert.equal(View.dayDivider(at(2026, 11, 13, 22, 0), at(2026, 11, 13, 23, 30), NOW, { formatTime }), null, 'same day: no line');
  assert.deepEqual(View.dayDivider(at(2026, 11, 13, 23, 59), at(2026, 11, 14, 0, 1), NOW, { formatTime }),
    { key: '2026-11-14', label: '오늘 · 오전 12:01' }, 'two minutes apart across midnight still gets a line');
  assert.equal(View.dayDivider(at(2026, 11, 14), undefined, NOW), null, 'a message with no time gets no line');
  assert.equal(View.dayDivider(at(2026, 11, 14), 0, NOW), null);
});

test('room kinds read Agent DM and Board Thread; provider names are not kind words', () => {
  assert.deepEqual({ ...View.threadKindView('dm') }, { kind: 'dm', label: 'Agent DM', createLabel: '새 Agent DM', title: 'Agent 하나와 나누는 개인 대화' });
  assert.equal(View.threadKindView('group').label, 'Board Thread');
  assert.equal(View.threadKindView('group').createLabel, '새 Board Thread');
  assert.equal(View.threadKindView(undefined).kind, 'dm', 'an unknown room reads as a DM, as the surface already treats it');
  for (const kind of ['dm', 'group']) assert.doesNotMatch(Object.values(View.threadKindView(kind)).join(' '), /Codex|Claude/);
});

test('the newest shown answer skips my messages and an answer with no words yet', () => {
  const messages = [
    { id: 'u1', role: 'user', content: '질문' },
    { id: 'a1', role: 'assistant', content: '답', status: 'done' },
    { id: 'u2', role: 'user', content: '다음' },
    { id: 'a2', role: 'assistant', content: '', status: 'streaming' },
  ];
  assert.equal(View.latestAnswerId(messages), 'a1');
  messages[3].content = '첫 글자';
  assert.equal(View.latestAnswerId(messages), 'a2');
  assert.equal(View.latestAnswerId([{ id: 'u1', role: 'user' }]), '');
  assert.equal(View.latestAnswerId(null), '');
});

test("'새 메시지' appears only while reading above when a new answer arrives, and stays until the bottom", () => {
  const base = { threadId: 'room', previousAnswerId: 'a1' };
  assert.equal(View.nextNewMessageNotice(null, { ...base, readingAbove: false, answerId: 'a2' }), null, 'at the bottom the log follows by itself');
  assert.equal(View.nextNewMessageNotice(null, { ...base, readingAbove: true, answerId: 'a1' }), null, 'the same answer growing is not a new message');
  const shown = View.nextNewMessageNotice(null, { ...base, readingAbove: true, answerId: 'a2' });
  assert.deepEqual(shown, { threadId: 'room', messageId: 'a2' });
  assert.equal(View.nextNewMessageNotice(shown, { ...base, previousAnswerId: 'a2', readingAbove: true, answerId: 'a2' }), shown, 'later renders keep it');
  assert.equal(View.nextNewMessageNotice(shown, { ...base, readingAbove: false, answerId: 'a3' }), null, 'reaching the bottom or sending clears it');
  assert.equal(View.nextNewMessageNotice(shown, { threadId: 'other', readingAbove: true, previousAnswerId: '', answerId: '' }), null, 'another room starts clean');
  assert.equal(View.nextNewMessageNotice(null, { threadId: 'room', readingAbove: true, previousAnswerId: '', answerId: 'a1' }).messageId, 'a1', 'the first answer counts too');
  assert.equal(View.nextNewMessageNotice(null, { threadId: '', readingAbove: true, answerId: 'a2' }), null);
});

test('the log counts as at the bottom within the same slack the surface scroll uses', () => {
  assert.equal(View.atLogBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }), true);
  assert.equal(View.atLogBottom({ scrollHeight: 1000, scrollTop: 577, clientHeight: 400 }), true);
  assert.equal(View.atLogBottom({ scrollHeight: 1000, scrollTop: 576, clientHeight: 400 }), false);
  assert.match(source, /atBottom: ChatHistoryView\.atLogBottom\(oldMessages\),/, 'the surface samples the bottom with the same rule');
});

function surfaceHelpers() {
  return compileFunction(`${declaration('buildCodexDayLine')}\n${declaration('buildCodexThreadKindBadge')}\n${declaration('buildCodexNewMessageButton')}
    return { buildCodexDayLine, buildCodexThreadKindBadge, buildCodexNewMessageButton };`,
  ['el', 'ChatHistoryView', 'formatMessageTime', 'deskIcon'])(el, View, formatTime, (name, className) => el('svg', { class: className, data: { icon: name } }));
}

test('the surface draws the day line, kind badge and new-message button from the view model', () => {
  assert.match(source, /const ChatHistoryView = ChromeUtils\.importESModule\('chrome:\/\/userchrome\/content\/EGDeskChatHistoryView\.sys\.mjs'\);/);
  const api = surfaceHelpers();
  const line = api.buildCodexDayLine(null, at(2026, 11, 14), NOW);
  assert.equal(line.className, 'egd-codex-day');
  assert.equal(line.props.role, 'separator');
  assert.equal(line.props['aria-label'], '오늘 · 오전 9:41');
  assert.deepEqual(line.dataset, { testid: 'chat-day', day: '2026-11-14' });
  assert.deepEqual(line.children.map(child => child.children[0]), ['오늘 · 오전 9:41']);
  assert.equal(api.buildCodexDayLine(at(2026, 11, 14), at(2026, 11, 14, 11), NOW), null);

  const dm = api.buildCodexThreadKindBadge({ type: 'dm' });
  assert.equal(dm.className, 'egd-codex-thread-kind egd-codex-thread-kind-dm');
  assert.deepEqual(dm.children, ['Agent DM']);
  assert.equal(dm.props.title, 'Agent 하나와 나누는 개인 대화');
  assert.deepEqual(dm.dataset, { testid: 'chat-thread-kind', kind: 'dm' });
  const board = api.buildCodexThreadKindBadge({ type: 'group' });
  assert.equal(board.className, 'egd-codex-thread-kind egd-codex-thread-kind-group');
  assert.deepEqual(board.children, ['Board Thread']);

  let pressed = 0;
  const button = api.buildCodexNewMessageButton(() => { pressed += 1; });
  assert.equal(button.tag, 'div');
  assert.equal(button.className, 'egd-codex-new-message-dock');
  const control = button.children[0];
  assert.equal(control.tag, 'button');
  assert.equal(control.props.type, 'button');
  assert.equal(control.props.title, '최신 메시지로 이동');
  assert.deepEqual(control.dataset, { testid: 'chat-new-message', focusKey: 'chat-new-message' });
  assert.equal(control.children.find(child => typeof child !== 'string' && child.className === 'egd-codex-new-message-text').children[0], '새 메시지');
  const stopped = [];
  control.props.onclick({ stopPropagation: () => stopped.push('stop') });
  assert.equal(pressed, 1);
  assert.deepEqual(stopped, ['stop']);
});

test('the message loop places a day line above the first message of each day', () => {
  const loop = between('          let lastDayAt = null;', '            const previous = activeThread.messages[index - 1] || null;');
  assert.match(loop, /if \(message\.role === 'assistant' && message\.status === 'streaming' && !message\.content\) return;\n\s*const dayLine = buildCodexDayLine\(lastDayAt, message\.createdAt, renderedAt\);/,
    'an answer that is not drawn yet does not open a day');
  assert.match(loop, /if \(dayLine\) messages\.appendChild\(dayLine\);\n\s*if \(Number\.isFinite\(message\.createdAt\) && message\.createdAt > 0\) lastDayAt = message\.createdAt;/);
  // The production lines above, run over three days of messages.
  const run = compileFunction(`const messages = { children: [], appendChild(node) { this.children.push(node); } };
    let lastDayAt = null;
    for (const message of list) {
      const dayLine = buildCodexDayLine(lastDayAt, message.createdAt, renderedAt);
      if (dayLine) messages.appendChild(dayLine);
      if (Number.isFinite(message.createdAt) && message.createdAt > 0) lastDayAt = message.createdAt;
      messages.appendChild(message.id);
    }
    return messages.children;`, ['list', 'renderedAt', 'buildCodexDayLine']);
  const shown = run([
    { id: 'm1', createdAt: at(2026, 11, 12, 10) }, { id: 'm2', createdAt: at(2026, 11, 12, 18) },
    { id: 'm3' }, { id: 'm4', createdAt: at(2026, 11, 13, 8) }, { id: 'm5', createdAt: at(2026, 11, 14, 9, 41) },
    { id: 'm6', createdAt: at(2026, 11, 14, 9, 50) },
  ], NOW, surfaceHelpers().buildCodexDayLine).map(node => typeof node === 'string' ? node : node.props['aria-label']);
  assert.deepEqual(shown, ['11월 12일', 'm1', 'm2', 'm3', '어제', 'm4', '오늘 · 오전 9:41', 'm5', 'm6']);
});

test("the log shows '새 메시지' only from the view rule, and pressing it goes to the newest message", () => {
  const wiring = between('      const msgEl = body.querySelector(".egd-codex-messages");', "      const newTaskList = body.querySelector('[data-testid=\"chat-task-list\"]');");
  assert.match(wiring, /newMessageNotice = ChatHistoryView\.nextNewMessageNotice\(newMessageNotice, \{\n\s*threadId: msgEl\.dataset\.threadId, readingAbove: preserveAnchor,\n\s*previousAnswerId: messageState\?\.lastAnswerId, answerId: msgEl\.dataset\.lastAnswerId,\n\s*\}\);/);
  assert.match(wiring, /lastAnswerId: msgEl\.dataset\.lastAnswerId,/, 'the next render compares against the answer this one showed');
  const helpers = surfaceHelpers();
  const listeners = {};
  const msgEl = {
    dataset: { threadId: 'room', lastAnswerId: 'a2' }, scrollHeight: 1000, scrollTop: 100, clientHeight: 400, children: [],
    appendChild(node) { node.remove = () => { this.children = this.children.filter(child => child !== node); }; this.children.push(node); },
    addEventListener(type, fn) { listeners[type] = fn; },
  };
  const block = between('        // A43: reading further up', '        const scrollIntent = {');
  const run = compileFunction(`let newMessageNotice = prior; let pendingMessageScroll = { stale: true };
    ${block}
    return { get notice() { return newMessageNotice; }, get pending() { return pendingMessageScroll; } };`,
  ['prior', 'msgEl', 'preserveAnchor', 'messageState', 'ChatHistoryView', 'buildCodexNewMessageButton']);
  const state = run(null, msgEl, true, { lastAnswerId: 'a1' }, View, helpers.buildCodexNewMessageButton);
  assert.deepEqual(state.notice, { threadId: 'room', messageId: 'a2' });
  assert.equal(msgEl.children.length, 1);
  assert.equal(msgEl.children[0].className, 'egd-codex-new-message-dock');
  listeners.scroll();
  assert.equal(msgEl.children.length, 1, 'still reading above: the button stays');
  msgEl.children[0].children[0].props.onclick({ stopPropagation() {} });
  assert.equal(msgEl.scrollTop, 1000, 'pressing it shows the newest message');
  assert.equal(state.pending, null, 'an unpainted restore of the old reading place is dropped');
  assert.equal(state.notice, null);
  assert.equal(msgEl.children.length, 0);

  // Scrolling down by hand clears it the same way.
  const again = run({ threadId: 'room', messageId: 'a2' }, msgEl, true, { lastAnswerId: 'a2' }, View, helpers.buildCodexNewMessageButton);
  assert.equal(msgEl.children.length, 1);
  msgEl.scrollTop = 590;
  listeners.scroll();
  assert.equal(again.notice, null);
  assert.equal(msgEl.children.length, 0);

  // At the bottom nothing is added.
  const quiet = { ...msgEl, children: [], appendChild(node) { this.children.push(node); } };
  assert.equal(run(null, quiet, false, { lastAnswerId: 'a1' }, View, helpers.buildCodexNewMessageButton).notice, null);
  assert.equal(quiet.children.length, 0);
});

test('both Chat heads and every room row carry the kind badge; DM words name the product, not the provider', () => {
  assert.equal((source.match(/buildCodexThreadKindBadge\(activeThread\)/g) || []).length, 2, 'HUD head and Canvas Board head');
  assert.match(source, /el\('div', \{ class: 'egd-codex-thread-title' \}, thread\.title\),\n\s*buildCodexThreadKindBadge\(thread\),/, 'the room row shows its kind beside the title');
  const meta = compileFunction(`${between('  const THREAD_KIND_META = {', '  const DEFAULT_CODEX_AGENT_PROFILE_ID')}\nreturn THREAD_KIND_META;`, [])();
  assert.equal(meta.dm.label, 'Agent DM');
  assert.equal(meta.dm.longLabel, 'Agent DM');
  assert.equal(meta.dm.createTitle, '새 Agent DM');
  assert.equal(meta.group.longLabel, 'Board Thread');
  assert.doesNotMatch(source, /새 Codex 대화|'Codex 대화'/);
  assert.match(source, /class: 'egd-codex-thread-home-new',\n\s*title: '새 Agent DM',\n\s*'aria-label': '새 Agent DM',/, 'the list + button names what it opens');
  assert.match(source, /'aria-label': '이전 내용을 가져오지 않고 새 방 열기',\s*data: \{ testid: 'chat-new-unbound-room' \}/);
  assert.match(source, /if \(role === 'system'\) return '시스템';/);
});

// A46: a refused message of mine goes back to the composer; sending stays my press.
test('a refused message returns its words to the composer without replacing what is being written', () => {
  assert.equal(View.resendAvailable({ role: 'user', status: 'failed', content: '보고서 요약해 줘' }), true);
  assert.equal(View.resendAvailable({ role: 'user', status: 'unconfirmed', content: '보고서' }), false, 'an unknown outcome is not offered again');
  assert.equal(View.resendAvailable({ role: 'user', status: 'failed', content: '   ' }), false);
  assert.equal(View.resendAvailable({ role: 'assistant', status: 'failed', content: '답' }), false);
  assert.deepEqual(View.resendDraft('', '보고서 요약해 줘'), { draft: '보고서 요약해 줘', changed: true });
  assert.deepEqual(View.resendDraft('  \n', '보고서 요약해 줘\n'), { draft: '보고서 요약해 줘', changed: true });
  assert.deepEqual(View.resendDraft('새로 쓰던 글 ', '보고서 요약해 줘'), { draft: '새로 쓰던 글\n\n보고서 요약해 줘', changed: true },
    'a draft in progress is kept and the refused words follow it');
  assert.deepEqual(View.resendDraft('보고서 요약해 줘', '보고서 요약해 줘'), { draft: '보고서 요약해 줘', changed: false }, 'pressing twice does not double the words');
  assert.deepEqual(View.resendDraft('쓰던 글', undefined), { draft: '쓰던 글', changed: false });
  assert.equal(View.RESEND_LABEL, '다시 보내기');
});

test("'다시 보내기' sits under a refused bubble and fills this Chat's composer through its own input handling", () => {
  const api = compileFunction(`${declaration('buildCodexResendButton')}\n${declaration('restoreCodexMessageToComposer')}
    return { buildCodexResendButton, restoreCodexMessageToComposer };`, ['el', 'ChatHistoryView', 'Event'])(el, View, class { constructor(type, init) { this.type = type; this.bubbles = init?.bubbles; } });
  const failed = { id: 'm7', role: 'user', status: 'failed', content: '보고서 요약해 줘' };
  let pressed = null;
  const button = api.buildCodexResendButton(failed, message => { pressed = message; });
  assert.equal(button.tag, 'button');
  assert.equal(button.className, 'egd-codex-resend');
  assert.equal(button.props.type, 'button');
  assert.deepEqual(button.children, ['다시 보내기']);
  assert.match(button.props.title, /입력창/);
  assert.deepEqual(button.dataset, { testid: 'chat-message-resend', messageId: 'm7', focusKey: 'message-resend-m7' });
  button.props.onclick({ stopPropagation() {} });
  assert.equal(pressed, failed);
  assert.equal(api.buildCodexResendButton({ ...failed, status: 'unconfirmed' }, () => {}), null);
  assert.equal(api.buildCodexResendButton({ id: 'a', role: 'assistant', status: 'failed', content: '답' }, () => {}), null);

  const events = [];
  const input = {
    value: '쓰던 글', focused: 0, selection: null,
    dispatchEvent(event) { events.push([event.type, event.bubbles, this.value]); },
    focus() { this.focused += 1; },
    setSelectionRange(start, end) { this.selection = [start, end]; },
  };
  const body = { querySelector: selector => selector === '.egd-codex-input' ? input : null };
  assert.equal(api.restoreCodexMessageToComposer(body, failed), true);
  assert.equal(input.value, '쓰던 글\n\n보고서 요약해 줘');
  assert.deepEqual(events, [['input', true, '쓰던 글\n\n보고서 요약해 줘']], "the composer's own input listener saves the draft and enables send");
  assert.equal(input.focused, 1);
  assert.deepEqual(input.selection, [input.value.length, input.value.length]);
  assert.equal(api.restoreCodexMessageToComposer(body, failed), true);
  assert.equal(events.length, 1, 'already there: only the focus moves');
  assert.equal(input.focused, 2);
  assert.equal(api.restoreCodexMessageToComposer({ querySelector: () => null }, failed), false);

  assert.match(source, /const resend = buildCodexResendButton\(message, \(refused\) => restoreCodexMessageToComposer\(body, refused\)\);/);
  assert.match(source, /if \(resend\) messageStack\.insertBefore\(resend, meta\);/);
  assert.doesNotMatch(declaration('restoreCodexMessageToComposer'), /sendMessage/, 'never an automatic resend');
  const rule = css.slice(css.indexOf('\n.egd-codex-resend {'), css.indexOf('}', css.indexOf('\n.egd-codex-resend {')) + 1);
  assert.match(rule, /color: var\(--egd-danger-ink\);/);
  assert.doesNotMatch(rule, /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  assert.match(css, /\.egd-codex-resend:hover \{[^}]*var\(--egd-/);
  assert.match(css, /\.egd-codex-resend:focus-visible \{[^}]*outline: var\(--egd-focus-outline\);/);
});

test('day line and new-message button use tokens, show focus, and do not animate under reduced motion', () => {
  const rule = (selector) => {
    const start = css.indexOf(`\n${selector} {`);
    assert.ok(start >= 0, `css rule: ${selector}`);
    return css.slice(start, css.indexOf('}', start) + 1);
  };
  const day = rule('.egd-codex-day');
  assert.match(day, /font-size: 11px;/);
  assert.match(day, /color: var\(--egd-on-surface-variant\);/);
  assert.match(day, /text-align: center;/);
  const dock = rule('.egd-codex-new-message-dock');
  assert.match(dock, /position: sticky;/);
  assert.match(dock, /height: 0;/, 'the button floats over the log without adding to its length');
  const button = rule('.egd-codex-new-message');
  assert.match(button, /background: var\(--egd-/);
  assert.match(button, /box-shadow: var\(--egd-/);
  assert.match(css, /\.egd-codex-new-message:hover \{[^}]*var\(--egd-/);
  assert.match(css, /\.egd-codex-new-message:active \{[^}]*var\(--egd-/);
  assert.match(css, /\.egd-codex-new-message:focus-visible \{[^}]*outline: var\(--egd-focus-outline\);/);
  assert.doesNotMatch(button, /animation/, 'the log redraws on every streamed word, so the button never replays an entrance');
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.egd-codex-new-message \{ transition: none; \}/);
  for (const block of [day, dock, button]) assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b|rgba?\(/, 'no colors outside the tokens');
});

test('held room shows the specific account mismatch without naming identities, and fresh action copies no room context', async () => {
  const Chat = await import('../overlay/resources/EGDeskChatState.sys.mjs');
  const auth = (email) => ({ isLoggedIn: true, authMode: 'chatgpt', accountId: 'chatgpt', accountEmail: email });
  const accountA = auth('a@egdesk.invalid');
  const old = { id: 'old', type: 'dm', agentProfileId: 'a-private-agent', profileEnabled: true, model: 'original-model',
    conversationId: 'old-native', messages: [{ content: 'private' }] };
  const detached = Chat.detachNativeThread(old, Chat.codexAccountKey(accountA), 'new-binding');
  assert.match(Chat.nativeBindingHoldText(detached), /시작한 계정을 확인하지 못해/);
  const held = Chat.reconcileNativeThread(detached, auth('b@egdesk.invalid'));
  assert.equal(held.conversationId, null);
  assert.equal(Chat.canResumeNativeThread(held, auth('b@egdesk.invalid')), false);
  assert.equal(held.retainedNativeBinding.conversationId, old.conversationId);
  assert.deepEqual(held.messages, old.messages);
  const label = Chat.nativeBindingHoldText(held);
  assert.match(label, /현재 계정이 달라.*기존 기록은 이 방에 남고, 새 방에는 대화나 초안을 가져가지 않습니다/);
  assert.doesNotMatch(label, /@/);
  const method = between('      openFreshRoomAfterAccountHold(threadId) {', '      createThread(type =');
  const state = { codex: { engineMenu: {}, threads: [held] } };
  const created = [];
  const api = Function('state', 'ChatState', 'getCodexThreadById', 'createThread', `return {${method} createThread}`)(
    state, Chat, (codex, id) => codex.threads.find(thread => thread.id === id), (...args) => created.push(args));
  assert.equal(api.openFreshRoomAfterAccountHold('other'), false);
  assert.equal(api.openFreshRoomAfterAccountHold('old'), true);
  assert.deepEqual(created, [['dm', { engineId: 'codex', openConversation: true }]]);
  assert.deepEqual(held.messages, old.messages, 'the hold action does not mutate the old transcript');
});

test('running settings use only per-turn model/effort, pinned profile, and actual tool policy evidence', async () => {
  const Chat = await import('../overlay/resources/EGDeskChatState.sys.mjs');
  const proto = Chat.createChatProtocolState();
  const event = (seq, name, details) => Chat.reduceChatEvent(proto, { type: 'chat.event', v: 2, engineId: 'codex', event: name,
    streamId: 's1', conversationId: 'c1', runId: 'r1', seq, details });
  const profileBinding = { profileId: 'pinned-agent', revision: 3, hash: 'fixture-hash' };
  const run = event(1, 'run.started', { status: 'inProgress', profileBinding, computerControl: { policy: 'off' },
    toolCeiling: { files: 'read', terminal: 'none' } });
  event(2, 'run.configuration', { configuration: { model: 'requested-not-applied', modelSource: 'turn-request', effort: 'thread-default', effortSource: 'native-thread' } });
  const settings = () => Object.fromEntries(Chat.chatRunningSettingsView(run));
  assert.equal(settings()['Agent 버전'], 'pinned-agent · 버전 3');
  assert.equal(settings()['컴퓨터 조작 정책'], '끔');
  assert.match(settings()['도구 제한'], /파일 읽기만.*터미널 실행 안 함/);
  assert.equal(settings()['모델'], '확인할 수 없음');
  assert.equal(settings()['추론 강도'], '확인할 수 없음');
  event(3, 'run.configuration', { configuration: { model: 'native-model', modelSource: 'native-turn', effort: 'low', effortSource: 'native-turn' } });
  assert.equal(settings()['모델'], 'native-model');
  assert.equal(settings()['추론 강도'], '낮음');
  event(4, 'run.configuration', { configuration: { model: 'next-model', modelSource: 'turn-request' } });
  assert.equal(settings()['모델'], 'native-model');
  assert.equal(Chat.chatRunningSettingsView({ ...run, status: 'completed' }), null);
  assert.equal(Chat.chatRunningSettingsView({ ...run, localHistory: true }), null);
});
