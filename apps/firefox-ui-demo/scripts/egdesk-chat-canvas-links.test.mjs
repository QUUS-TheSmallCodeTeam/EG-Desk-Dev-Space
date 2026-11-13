import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  WORK_SCREEN_LABEL, chatReturnOrigin, chatReturnPlan, runWorkScreen, suggestionHighlight,
} from '../overlay/resources/EGDeskChatCanvasLinks.sys.mjs';

const surfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const surfaceCss = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
const declaration = name => {
  const start = surfaceSource.indexOf(`  function ${name}(`);
  const end = start < 0 ? -1 : surfaceSource.indexOf('\n  }\n', start);
  return end < 0 ? null : surfaceSource.slice(start, end + 4);
};
const compileFunction = (body, keys) => new Function(...keys, body);

// A tiny DOM: enough for el(), listeners and class lists.
function fakeDocument() {
  class Node {
    constructor(tag, text = '') {
      Object.assign(this, { tag, text, children: [], attributes: {}, dataset: {}, listeners: {}, className: '', style: {}, isConnected: true, hidden: false });
      const node = this;
      this.classList = { add: name => { if (!node.classList.contains(name)) node.className = `${node.className} ${name}`.trim(); },
        remove: name => { node.className = node.className.split(/\s+/).filter(item => item && item !== name).join(' '); },
        contains: name => node.className.split(/\s+/).includes(name) };
    }
    appendChild(child) { this.children.push(child); child.parent = this; return child; }
    append(...nodes) { for (const node of nodes) this.appendChild(node); }
    remove() { this.removed = true; this.isConnected = false; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(type, callback, options) {
      const list = (this.listeners[type] ||= []);
      list.push(callback);
      options?.signal?.addEventListener('abort', () => { this.listeners[type] = (this.listeners[type] || []).filter(item => item !== callback); });
    }
    get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
    all(match) { return this.children.flatMap(child => [...(match(child) ? [child] : []), ...child.all(match)]); }
    testid(id) { return this.all(child => child.dataset.testid === id)[0] || null; }
    contains(node) { return node === this || this.children.some(child => child.contains(node)); }
    dispatch(type, fields = {}) {
      const event = { target: this, currentTarget: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}, ...fields };
      for (const callback of [...(this.listeners[type] || [])]) callback(event);
      return event;
    }
    focus() { this.focused = (this.focused || 0) + 1; }
  }
  const byId = new Map();
  const doc = { createElement: tag => new Node(tag), createTextNode: value => new Node('#text', String(value)),
    documentElement: new Node('html'), getElementById: id => { const node = byId.get(id); return node && node.isConnected ? node : null; },
    register(id, node) { node.id = id; byId.set(id, node); return node; }, activeElement: null };
  const append = doc.documentElement.appendChild.bind(doc.documentElement);
  doc.documentElement.appendChild = node => { if (node.attributes.id) byId.set(node.attributes.id, node); return append(node); };
  return doc;
}
const elBody = surfaceSource.match(/  function el\(tag, props = \{\}, \.\.\.children\) \{([^]*?)\n  \}/)?.[1];
const elFor = doc => compileFunction(`return function el(tag, props = {}, ...children) {${elBody}\n};`, ['document'])(doc);

// ---- 현재 작업 화면 (B33/B47) ----

const key = (runId, cardId, epoch = 1) => `${runId}\u0000${cardId}\u0000${epoch}`;
const cards = { 'card-a': { name: '견적서 검토' }, 'card-b': { name: '' } };
const cardFor = id => cards[id] || null;

test('runWorkScreen: the open Card a busy run is bound to, the one it may act on first', () => {
  const bindings = new Map([
    [key('run-1', 'card-b'), { binding: { cardId: 'card-b' }, permission: 'observe' }],
    [key('run-1', 'card-a'), { binding: { cardId: 'card-a' }, permission: 'interact' }],
    [key('run-2', 'card-b'), { binding: { cardId: 'card-b' }, permission: 'observe' }],
  ]);
  assert.deepEqual(runWorkScreen({ runId: 'run-1' }, bindings, { busy: true, cardFor }), {
    cardId: 'card-a', label: '현재 작업 화면', title: '견적서 검토 창으로 화면 이동', ariaLabel: '현재 작업 화면 · 견적서 검토 창으로 화면 이동' });
  assert.equal(WORK_SCREEN_LABEL, '현재 작업 화면');
  // A Card without a readable name is still a Browser window.
  assert.equal(runWorkScreen({ runId: 'run-2' }, bindings, { busy: true, cardFor }).title, 'Browser 창으로 화면 이동');
  // Two Cards with the same permission: the one bound last is where the Agent is now.
  const two = new Map([[key('run-3', 'card-a'), { binding: { cardId: 'card-a' }, permission: 'interact' }],
    [key('run-3', 'card-b'), { binding: { cardId: 'card-b' }, permission: 'interact' }]]);
  assert.equal(runWorkScreen({ runId: 'run-3' }, two, { busy: true, cardFor }).cardId, 'card-b');
});

test('runWorkScreen: no button without a live target', () => {
  const bindings = new Map([[key('run-1', 'card-a'), { binding: { cardId: 'card-a' }, permission: 'interact' }]]);
  assert.equal(runWorkScreen({ runId: 'run-1' }, bindings, { busy: false, cardFor }), null, 'a finished run is not working anywhere');
  assert.equal(runWorkScreen({ runId: 'run-1' }, bindings, { cardFor }), null);
  assert.equal(runWorkScreen({ runId: 'run-9' }, bindings, { busy: true, cardFor }), null, 'another run');
  assert.equal(runWorkScreen({ runId: 'run-1' }, bindings, { busy: true, cardFor: () => null }), null, 'the Card was closed');
  assert.equal(runWorkScreen({ runId: 'run-1' }, bindings, { busy: true, cardFor, cancelled: new Set([key('run-1', 'card-a')]) }), null, 'a cancelled binding');
  assert.equal(runWorkScreen({ runId: 'run' }, new Map([[key('run-1', 'card-a'), { binding: { cardId: 'card-a' } }]]), { busy: true, cardFor }), null, 'a run id prefix never matches');
  for (const bad of [null, {}, { runId: '' }, { runId: 7 }]) assert.equal(runWorkScreen(bad, bindings, { busy: true, cardFor }), null);
  assert.equal(runWorkScreen({ runId: 'run-1' }, null, { busy: true, cardFor }), null);
  assert.equal(runWorkScreen({ runId: 'run-1' }, new Map([[key('run-1', 'card-a'), null], [7, {}], [key('run-1', ''), { binding: {} }]]), { busy: true, cardFor }), null);
});

test('[현재 작업 화면] is drawn only for a busy run with an open Card and moves the camera only when pressed', () => {
  const doc = fakeDocument();
  const el = elFor(doc);
  const calls = [];
  const browserCard = doc.register('egd-browser-card-3', doc.createElement('article'));
  browserCard.className = 'egd-canvas-card egd-browser-card';
  const chatCard = doc.register('egd-chat-card-1', doc.createElement('article'));
  const bindings = new Map([[key('run-1', 'egd-browser-card-3'), { binding: { cardId: 'egd-browser-card-3' }, permission: 'interact' }]]);
  const cancelled = new Map();
  const state = { codex: { chatCardEntityId: 'egd-chat-card-1' } };
  const parts = compileFunction(`${declaration('codexRunWorkScreen')}\n${declaration('goToRunWorkScreen')}\n${declaration('codexRunWorkScreenButton')}
    return { codexRunWorkScreen, goToRunWorkScreen, codexRunWorkScreenButton };`,
  ['document', 'el', 'state', 'ChatState', 'ChatCanvasLinks', 'browserToolRunBindings', 'browserToolCancelledRuns', 'contextCandidateLabel',
    'cardLabelForViewportRail', 'deskIcon', 'boardNotice', 'focusCanvasCard', 'revealOpenCanvasCard'])(
    doc, el, state, { isRunBusy: run => run.status === 'running' }, { runWorkScreen }, bindings, cancelled, card => card === browserCard ? 'Browser · example.com' : null,
    () => 'Browser', () => doc.createElement('svg'), message => calls.push(['notice', message]),
    card => calls.push(['focus', card.id]), (card, options) => calls.push(['reveal', card.id, options.kind, options.opener?.id || null]));

  const button = parts.codexRunWorkScreenButton({ runId: 'run-1', status: 'running' });
  assert.equal(button.tag, 'button');
  assert.equal(button.textContent, '현재 작업 화면');
  assert.equal(button.className, 'egd-codex-work-screen');
  assert.equal(button.attributes.title, 'Browser · example.com 창으로 화면 이동');
  assert.equal(button.attributes['aria-label'], '현재 작업 화면 · Browser · example.com 창으로 화면 이동');
  assert.deepEqual({ ...button.dataset }, { testid: 'chat-run-work-screen', runId: 'run-1', cardId: 'egd-browser-card-3', focusKey: 'work-screen:chat-run-work-screen:run-1' });
  assert.deepEqual(calls, [], 'drawing it moves nothing');
  button.dispatch('click');
  assert.deepEqual(calls, [['focus', 'egd-browser-card-3'], ['reveal', 'egd-browser-card-3', 'browser', 'egd-chat-card-1']],
    'the Card is brought into view with its Chat as the opener, so the way back can stay up');

  // No target, no button: a finished run, a run without a Card, a cancelled binding, a closed Card.
  assert.equal(parts.codexRunWorkScreenButton({ runId: 'run-1', status: 'completed' }), null);
  assert.equal(parts.codexRunWorkScreenButton({ runId: 'run-2', status: 'running' }), null);
  assert.equal(parts.codexRunWorkScreenButton({ status: 'running' }), null);
  cancelled.set(key('run-1', 'egd-browser-card-3'), true);
  assert.equal(parts.codexRunWorkScreenButton({ runId: 'run-1', status: 'running' }), null);
  cancelled.clear();
  // The working bubble's rows carry only a run id and are busy by definition.
  assert.equal(parts.codexRunWorkScreenButton({ runId: 'run-1' }, { busy: true, testid: 'chat-agent-work-screen' }).dataset.testid, 'chat-agent-work-screen');
  assert.equal(parts.codexRunWorkScreenButton({ runId: 'run-1' }), null);
  // The Card closed between the draw and the press: a plain sentence, no camera move.
  calls.length = 0;
  const stale = parts.codexRunWorkScreenButton({ runId: 'run-1', status: 'running' });
  browserCard.isConnected = false;
  stale.dispatch('click');
  assert.deepEqual(calls, [['notice', '작업 화면을 찾지 못했습니다. 창이 닫혔을 수 있습니다.']]);
  assert.equal(parts.codexRunWorkScreenButton({ runId: 'run-1', status: 'running' }), null);

  // Wiring: under each run head in the activity record and under each working bubble; guarded where those blocks run alone.
  const panel = declaration('renderCodexActivityPanel') || '';
  assert.match(panel, /rows\.push\(el\('h4', \{ data: \{ runId: run\.runId \} \}, codexRunLabel\(run\)\)\);\n(?:\s*\/\/[^\n]*\n)*\s*const workScreen = typeof codexRunWorkScreenButton === 'function' \? codexRunWorkScreenButton\(run\) : null;\n\s*if \(workScreen\) rows\.push\(workScreen\);/);
  assert.match(surfaceSource, /workScreen: typeof codexRunWorkScreenButton === 'function' \? codexRunWorkScreenButton\(workingRun, \{ testid: 'chat-agent-work-screen' \}\) : null,/);
  assert.match(surfaceSource, /workScreen: typeof codexRunWorkScreenButton === 'function' \? codexRunWorkScreenButton\(\{ runId: row\.runId \}, \{ busy: true, testid: 'chat-agent-work-screen' \}\) : null,/);
  const row = compileFunction(`${declaration('codexMessageAvatarFace')}\n${declaration('codexAgentWorkingRow')}\nreturn codexAgentWorkingRow;`, ['document', 'el', 'ChatState'])(
    doc, el, { profileAvatarView: () => ({ kind: 'initial', text: 'C', tone: 0 }) });
  const withScreen = row({ state: 'working', text: 'Agent 작업 중' }, { runId: 'run-1', name: 'Codex', workScreen: button });
  const stack = withScreen.all(node => node.className === 'egd-codex-working-stack')[0];
  assert.equal(stack.children.at(-1), button, 'under the bubble');
  assert.equal(stack.children.at(-2).dataset.testid, 'chat-agent-working-open', 'the bubble still opens the record');
  const without = row({ state: 'working', text: 'Agent 작업 중' }, { runId: 'run-1', name: 'Codex' });
  assert.equal(without.all(node => node.className === 'egd-codex-work-screen').length, 0);
  // Style: tokens only, with hover and focus.
  for (const [, body] of surfaceCss.matchAll(/button\.egd-codex-work-screen[^{]*\{([^}]+)\}/g)) assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'tokens only');
  assert.match(surfaceCss, /button\.egd-codex-work-screen:hover,/);
  assert.match(surfaceCss, /button\.egd-codex-work-screen:focus-visible,\n#egd-codex-activity-panel button\.egd-codex-work-screen:focus-visible \{ outline: var\(--egd-focus-outline\);/);
});

// ---- 채팅으로 돌아가기 (B44) ----

test('chatReturnOrigin keeps the camera and the conversation scroll it left from', () => {
  assert.deepEqual(chatReturnOrigin({ pan: { x: 24, y: 76, extra: 1 }, zoom: 0.8, threadId: 't1', scrollTop: 420.5 }),
    { camera: { pan: { x: 24, y: 76 }, zoom: 0.8 }, threadId: 't1', scrollTop: 420.5 });
  assert.deepEqual(chatReturnOrigin({ pan: { x: 0, y: 0 }, zoom: 1 }), { camera: { pan: { x: 0, y: 0 }, zoom: 1 }, threadId: null, scrollTop: null });
  assert.equal(chatReturnOrigin({ pan: { x: 0, y: 0 }, zoom: 1, threadId: 't1', scrollTop: -3 }).scrollTop, null);
  for (const bad of [undefined, {}, { pan: { x: NaN, y: 0 }, zoom: 1 }, { pan: { x: 0, y: 0 }, zoom: 0 }, { pan: null, zoom: 1 }]) assert.equal(chatReturnOrigin(bad), null);
});

test('chatReturnPlan: back to the saved view while the Chat is still there, the same conversation back to its place', () => {
  const origin = chatReturnOrigin({ pan: { x: 100, y: 50 }, zoom: 0.5, threadId: 't1', scrollTop: 300 });
  const safe = { left: 24, top: 76, right: 1256, bottom: 700 };
  const chat = { x: 400, y: 200, width: 420, height: 600 }; // on screen at 300..510 x 150..450
  assert.deepEqual(chatReturnPlan(origin, { activeThreadId: 't1', chat, safe }), { camera: { pan: { x: 100, y: 50 }, zoom: 0.5 }, scrollTop: 300 });
  assert.deepEqual(chatReturnPlan(origin, { activeThreadId: 't2', chat, safe }), { camera: { pan: { x: 100, y: 50 }, zoom: 0.5 }, scrollTop: null },
    'another conversation keeps its own scroll');
  // The Chat was moved away since: the saved view no longer shows it, so the caller brings the Chat itself.
  assert.deepEqual(chatReturnPlan(origin, { activeThreadId: 't1', chat: { ...chat, x: 5000 }, safe }), { camera: null, scrollTop: 300 });
  assert.deepEqual(chatReturnPlan(origin, { activeThreadId: 't1', chat: null, safe }), { camera: null, scrollTop: 300 });
  assert.deepEqual(chatReturnPlan(null, { activeThreadId: 't1', chat, safe }), { camera: null, scrollTop: null });
  assert.deepEqual(chatReturnPlan(chatReturnOrigin({ pan: { x: 0, y: 0 }, zoom: 1 }), { activeThreadId: null, chat: { x: 30, y: 80, width: 10, height: 10 }, safe }),
    { camera: { pan: { x: 0, y: 0 }, zoom: 1 }, scrollTop: null });
});

test('the way back stays until used, closed or the Chat is back, and returns to the view it left', () => {
  const doc = fakeDocument();
  const el = elFor(doc);
  const calls = [];
  const state = { panTarget: { x: 24, y: 76 }, zoomTarget: 0.9, codex: { activeThreadId: 't1' },
    setCanvasViewportTarget: camera => calls.push(['camera', camera]), focusChatDockIfCompact: card => { calls.push(['dock', card.id]); return false; } };
  const timers = [];
  const windowStub = { setTimeout: (fn, ms) => { timers.push(ms); return timers.length; }, clearTimeout() {} };
  const show = compileFunction(`${declaration('showChatReturnCue')}\nreturn showChatReturnCue;`,
    ['document', 'el', 'window', 'state', 'deskIcon', 'focusCanvasCard', 'ChatCanvasLinks', 'persistentEntityGeometry', 'safeViewportRect', 'AbortController'])(
    doc, el, windowStub, state, () => doc.createElement('svg'), card => calls.push(['focus', card.id]),
    { chatReturnOrigin, chatReturnPlan }, card => card.geometry, () => ({ left: 24, top: 76, right: 1256, bottom: 700 }), AbortController);
  const chatCard = (id, fields = {}) => {
    const card = doc.createElement('article');
    const log = doc.createElement('div');
    log.scrollTop = 640;
    Object.assign(card, { id, geometry: { x: 0, y: 0, width: 420, height: 600 }, log, querySelector: selector => selector === '.egd-codex-messages' ? card.log : null, ...fields });
    return card;
  };
  const chat = chatCard('chat-1');
  const cue = show(chat);
  assert.equal(cue.attributes.id, 'egd-chat-return');
  assert.equal(cue.attributes.role, 'group');
  assert.equal(cue.attributes['aria-label'], '채팅으로 돌아가기');
  const back = cue.testid('chat-return'), close = cue.testid('chat-return-close');
  assert.equal(back.textContent, '채팅으로 돌아가기');
  assert.equal(back.attributes.title, '떠나기 전 화면과 대화 위치로 돌아갑니다');
  assert.equal(close.attributes['aria-label'], '채팅으로 돌아가기 닫기');
  assert.equal(close.attributes.title, '닫기');
  assert.deepEqual(timers, [], 'no timer takes it away');

  // The camera moved on and the conversation scrolled since; returning restores both.
  state.panTarget = { x: -900, y: -400 }; state.zoomTarget = 1;
  chat.log.scrollTop = 0;
  back.dispatch('click');
  assert.deepEqual(calls, [['camera', { pan: { x: 24, y: 76 }, zoom: 0.9 }], ['focus', 'chat-1']]);
  assert.equal(chat.log.scrollTop, 640);
  assert.equal(cue.removed, true);
  assert.deepEqual(chat.listeners.mousedown, [], 'its Chat listeners go with it');

  // Closed by the user: nothing moves.
  calls.length = 0;
  const second = show(chatCard('chat-2'));
  second.testid('chat-return-close').dispatch('click');
  assert.deepEqual([second.removed, calls], [true, []]);
  // Esc inside the cue closes it too and stops there.
  const third = show(chatCard('chat-3'));
  const esc = third.dispatch('keydown', { key: 'Escape' });
  assert.deepEqual([third.removed, esc.defaultPrevented, calls], [true, true, []]);
  const other = show(chatCard('chat-3b'));
  other.dispatch('keydown', { key: 'Enter' });
  assert.notEqual(other.removed, true);

  // One cue at a time; a click or focus into the Chat means it is back.
  const fourthChat = chatCard('chat-4');
  const fourth = show(fourthChat);
  assert.equal(other.removed, true);
  fourthChat.dispatch('mousedown');
  assert.equal(fourth.removed, true);
  const fifthChat = chatCard('chat-5');
  const fifth = show(fifthChat);
  fifthChat.dispatch('focusin');
  assert.equal(fifth.removed, true);

  // The Chat was dragged elsewhere since: the saved view would not show it, so the Chat itself is brought back.
  const moved = chatCard('chat-6');
  const sixth = show(moved);
  moved.geometry = { x: 9000, y: 9000, width: 420, height: 600 };
  sixth.testid('chat-return').dispatch('click');
  assert.deepEqual(calls, [['dock', 'chat-6'], ['focus', 'chat-6']]);
  // A closed Chat: the cue just leaves.
  calls.length = 0;
  const gone = chatCard('chat-7');
  const seventh = show(gone);
  gone.isConnected = false;
  seventh.testid('chat-return').dispatch('click');
  assert.deepEqual([seventh.removed, calls], [true, []]);

  assert.doesNotMatch(surfaceSource, /CHAT_RETURN_CUE_MS/, 'the six-second limit is gone');
  assert.match(surfaceSource, /\} else if \(item\.id === 'chat'\) \{\n                dismissChatReturnCue\(\);/, 'the Dock Chat button still clears it');
  const rule = surfaceCss.match(/^#egd-chat-return \{([^}]+)\}/m)?.[1] || '';
  assert.match(rule, /bottom: 70px;/, 'above the Dock');
  assert.match(surfaceCss, /^#egd-chat-return \.egd-chat-return-close:focus-visible \{ outline: var\(--egd-focus-outline\);/m);
  for (const [, body] of surfaceCss.matchAll(/^#egd-chat-return[^{]*\{([^}]+)\}/gm)) assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'tokens only');
});

// ---- 추천 자료 위치 강조 (B77) ----

test('suggestionHighlight: the Card to outline follows the hovered or focused row and never outlives it', () => {
  const none = { ref: null };
  assert.deepEqual(suggestionHighlight(none, { type: 'enter', ref: 'card-a' }), { ref: 'card-a' });
  assert.deepEqual(suggestionHighlight({ ref: 'card-a' }, { type: 'enter', ref: 'card-b' }), { ref: 'card-b' });
  assert.deepEqual(suggestionHighlight({ ref: 'card-a' }, { type: 'leave', ref: 'card-a' }), none);
  assert.deepEqual(suggestionHighlight({ ref: 'card-b' }, { type: 'leave', ref: 'card-a' }), { ref: 'card-b' }, 'leaving an older row keeps the newer one');
  assert.deepEqual(suggestionHighlight({ ref: 'card-a' }, { type: 'clear' }), none);
  assert.deepEqual(suggestionHighlight({ ref: 'card-a' }, { type: 'enter', ref: '' }), none);
  assert.deepEqual(suggestionHighlight(undefined, { type: 'enter', ref: 7 }), none);
  assert.deepEqual(suggestionHighlight({ ref: 'card-a' }, null), { ref: 'card-a' });
});

test('a recommended material row outlines its Card while hovered or keyboard-focused, and nothing else changes', () => {
  // Minimal nodes: class list, closest/matches/contains by hand.
  const classes = () => { const set = new Set(); return { add: name => set.add(name), remove: name => set.delete(name), contains: name => set.has(name), set }; };
  const card = (id, selector = '.egd-canvas-card, .egd-canvas-shape') => ({ id, isConnected: true, classList: classes(), matches: query => query === selector });
  const cardsById = { 'card-a': card('card-a'), 'card-b': card('card-b'), 'egd-hud': card('egd-hud', '#egd-hud') };
  const doc = { activeElement: null, getElementById: id => cardsById[id] || null, listeners: {}, addEventListener(type, fn, capture) { this.listeners[type] = [fn, capture]; } };
  const makeRow = ref => {
    const row = { dataset: { ref }, isConnected: true, hovered: false, parts: new Set() };
    row.closest = query => query === '.egd-context-suggest-row' ? row : null;
    row.contains = node => node === row || row.parts.has(node);
    row.matches = query => query === ':hover' ? row.hovered : false;
    row.part = (focusVisible = false) => { const part = { closest: row.closest, matches: query => query === ':focus-visible' ? focusVisible : false }; row.parts.add(part); return part; };
    return row;
  };
  const outside = { closest: () => null, matches: () => false };
  const block = surfaceSource.slice(surfaceSource.indexOf('  const contextSuggestOutline = { ref: null, row: null };'),
    surfaceSource.indexOf("  for (const type of ['mouseover', 'mouseout', 'focusin', 'focusout']) document.addEventListener(type, contextSuggestOutlineEvent, true);"));
  assert.ok(block.includes('function contextSuggestOutlineEvent(ev)'));
  const { contextSuggestOutlineEvent: fire, contextSuggestOutline: held } = compileFunction(`${block}\nreturn { contextSuggestOutlineEvent, contextSuggestOutline };`,
    ['document', 'ChatCanvasLinks'])(doc, { suggestionHighlight });
  const outlined = () => Object.values(cardsById).filter(item => item.classList.contains('egd-entity-suggested')).map(item => item.id);

  const rowA = makeRow('card-a'), rowB = makeRow('card-b');
  fire({ type: 'mouseover', target: rowA.part() });
  assert.deepEqual(outlined(), ['card-a']);
  fire({ type: 'mouseout', target: rowA.part(), relatedTarget: rowA.part() });
  assert.deepEqual(outlined(), ['card-a'], 'moving inside the row keeps it');
  fire({ type: 'mouseover', target: rowB.part() });
  assert.deepEqual(outlined(), ['card-b'], 'one Card at a time');
  fire({ type: 'mouseout', target: rowB.part(), relatedTarget: outside });
  assert.deepEqual([outlined(), held.ref, held.row], [[], null, null], 'only while the pointer is on the row');

  // Keyboard focus outlines; a click's focus alone does not.
  fire({ type: 'focusin', target: rowA.part(false) });
  assert.deepEqual(outlined(), []);
  const focusedA = rowA.part(true);
  fire({ type: 'focusin', target: focusedA });
  assert.deepEqual(outlined(), ['card-a']);
  // The pointer visits another row and leaves: the keyboard's row takes the outline back.
  doc.activeElement = focusedA;
  fire({ type: 'mouseover', target: rowB.part() });
  fire({ type: 'mouseout', target: rowB.part(), relatedTarget: outside });
  assert.deepEqual(outlined(), ['card-a']);
  fire({ type: 'focusout', target: focusedA, relatedTarget: outside });
  assert.deepEqual(outlined(), []);
  doc.activeElement = null;
  // Focus leaving a row the pointer still rests on keeps the outline.
  fire({ type: 'mouseover', target: rowB.part() });
  rowB.hovered = true;
  fire({ type: 'focusout', target: rowB.part(), relatedTarget: outside });
  assert.deepEqual(outlined(), ['card-b']);
  rowB.hovered = false;

  // The Chat redrew and the row is gone: the next move anywhere else drops the outline.
  rowB.isConnected = false;
  fire({ type: 'mouseover', target: outside });
  assert.deepEqual([outlined(), held.ref], [[], null]);
  // A row whose Card is closed, or whose ref is not a Canvas object, outlines nothing.
  fire({ type: 'mouseover', target: makeRow('card-gone').part() });
  fire({ type: 'mouseover', target: makeRow('egd-hud').part() });
  assert.deepEqual([outlined(), held.ref], [[], null]);
  fire({ type: 'mouseover', target: outside });
  assert.deepEqual(outlined(), []);

  // Wiring and style: document-level listeners (rows are redrawn), no camera call, tokens only.
  assert.doesNotMatch(block, /setCanvasPanTarget|setCanvasViewportTarget|focusCanvasCard|revealOpenCanvasCard|setActiveEntity/, 'the camera and selection stay as they are');
  assert.match(surfaceSource, /  for \(const type of \['mouseover', 'mouseout', 'focusin', 'focusout'\]\) document\.addEventListener\(type, contextSuggestOutlineEvent, true\);/);
  assert.match(declaration('buildContextSuggestions'), /class: `egd-context-suggest-row egd-context-suggest-row-\$\{row\.mode\}`,[^]*?data: \{ testid: 'chat-context-candidate', ref: row\.ref, mode: row\.mode \}/,
    'each row names its Card by ref');
  const rule = surfaceCss.match(/^\.egd-canvas-card\.egd-entity-suggested,\n\.egd-canvas-shape\.egd-entity-suggested \{([^}]+)\}/m)?.[1] || '';
  assert.match(rule, /outline: calc\(2px \/ var\(--egd-camera-zoom, 1\)\) dashed var\(--egd-card-selection\);/);
  assert.match(rule, /outline-offset: calc\(3px \/ var\(--egd-camera-zoom, 1\)\);/);
  assert.doesNotMatch(rule, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'tokens only');
});
