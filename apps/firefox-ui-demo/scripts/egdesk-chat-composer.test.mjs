import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {
  MENTION_LIST_LABEL, mentionNames, mentionQueryAt, mentionMatches, emptyMention, nextMention, moveMention, dismissMention,
  applyMention, mentionKeyAction,
} from '../overlay/resources/EGDeskChatComposer.sys.mjs';
import { mentionSpans, threadAgentNames } from '../overlay/resources/EGDeskThreadRouting.sys.mjs';

const board = { id: 'room-b', type: 'group', participants: ['나', '코덱스 어시스턴트', '디자인 리뷰어', 'Rio'] };
const dm = { id: 'room-a', type: 'dm', participants: ['나', 'Rio'] };
const names = mentionNames(board);
const at = (text, caret = text.length) => mentionQueryAt(text, caret, names);
const step = (prev, text, extra = {}) => nextMention(prev, { names, text, caret: text.length, ...extra });

// ------------------------------------------------------------------ who can be called

test('candidates: a Board Thread offers its Agents and then 나; an Agent DM offers nobody', () => {
  assert.deepEqual(names, ['코덱스 어시스턴트', '디자인 리뷰어', 'Rio', '나']);
  assert.deepEqual(names.slice(0, -1), threadAgentNames(board), 'the same Agent names the sent bubble chips use');
  assert.deepEqual(mentionNames(dm), []);
  assert.deepEqual(mentionNames(null), []);
  assert.deepEqual(mentionNames({ type: 'group', participants: ['나', 'Rio', 'Rio', '', null] }), ['Rio', '나']);
  assert.deepEqual(mentionNames({ type: 'group', participants: ['대표', 'Rio'] }, '대표'), ['Rio', '대표']);
});

// ------------------------------------------------------------------ the '@…' at the caret

test('query: an @ at the start or after a space opens; an @ inside a word or an address does not', () => {
  assert.deepEqual(at('@'), { start: 0, end: 1, query: '' });
  assert.deepEqual(at('안녕 @디자'), { start: 3, end: 6, query: '디자' });
  assert.deepEqual(at('첫 줄\n@R'), { start: 4, end: 6, query: 'R' });
  assert.deepEqual(at('(@R'), { start: 1, end: 3, query: 'R' });
  assert.equal(at('mail@R'), null);
  assert.equal(at('안녕'), null);
  assert.equal(at(''), null);
  assert.equal(at('@R\n다음 줄'), null, 'the @ belongs to the line the caret is on');
});

test('query: a space continues the query only while it still starts a name', () => {
  assert.deepEqual(at('@디자인 리'), { start: 0, end: 6, query: '디자인 리' });
  assert.equal(at('@디자인 리뷰어 '), null, 'a finished call is not a query');
  assert.equal(at('@Rio 안녕'), null);
  assert.equal(at('@없는 이름'), null);
  assert.deepEqual(at('@없는'), { start: 0, end: 3, query: '없는' }, 'no space yet: still a query, with nothing to offer');
});

test('query: only the text before the caret counts, and a far-away @ is ignored', () => {
  assert.deepEqual(mentionQueryAt('@Rio 안녕', 2, names), { start: 0, end: 2, query: 'R' });
  assert.equal(mentionQueryAt('@Rio', 0, names), null);
  assert.equal(at(`@${'가'.repeat(41)}`), null);
  assert.equal(mentionQueryAt('@R', 9, names)?.end, 2, 'a caret past the end is the end');
});

test('matches: names that start with the query come first, then names that contain it; case does not matter', () => {
  assert.deepEqual(mentionMatches(names, ''), names);
  assert.deepEqual(mentionMatches(names, '디'), ['디자인 리뷰어']);
  assert.deepEqual(mentionMatches(names, 'rio'), ['Rio']);
  assert.deepEqual(mentionMatches(names, '리뷰'), ['디자인 리뷰어']);
  assert.deepEqual(mentionMatches(['리뷰 도우미', '디자인 리뷰어'], '리뷰'), ['리뷰 도우미', '디자인 리뷰어']);
  assert.deepEqual(mentionMatches(names, '없는'), []);
});

// ------------------------------------------------------------------ list state

test('state: typing @ opens the list on its first row and typing narrows it', () => {
  let state = step(emptyMention(), '@');
  assert.equal(state.open, true);
  assert.deepEqual(state.items.map(item => [item.name, item.kind, item.label, item.hint]), [
    ['코덱스 어시스턴트', 'agent', '@코덱스 어시스턴트', 'Agent'], ['디자인 리뷰어', 'agent', '@디자인 리뷰어', 'Agent'],
    ['Rio', 'agent', '@Rio', 'Agent'], ['나', 'user', '@나', '대표님']]);
  assert.equal(state.index, 0);
  state = moveMention(state, 1);
  assert.equal(state.index, 1);
  state = step(state, '@');
  assert.equal(state.index, 1, 'a redraw with the same text keeps the highlighted row');
  state = step(state, '@R');
  assert.deepEqual([state.open, state.index, state.items.map(item => item.name)], [true, 0, ['Rio']]);
  state = step(state, '@Rx');
  assert.deepEqual([state.open, state.items.length], [false, 0], 'nothing to offer: no empty list');
  state = step(state, '안녕');
  assert.deepEqual(state, emptyMention());
});

test('state: an Agent DM, an unfocused composer and a selection never open the list', () => {
  assert.equal(nextMention(emptyMention(), { names: mentionNames(dm), text: '@', caret: 1 }).open, false);
  assert.equal(step(emptyMention(), '@', { active: false }).open, false);
  assert.equal(nextMention(emptyMention(), { names, text: '@R', caret: 2, selectionEnd: 1 }).open, false);
});

test('state: the list does not open during Korean composition, but an open list keeps narrowing', () => {
  assert.equal(step(emptyMention(), '@디', { composing: true }).open, false, 'not opened mid-composition');
  let state = step(emptyMention(), '@');
  state = step(state, '@디', { composing: true });
  assert.deepEqual([state.open, state.items.map(item => item.name)], [true, ['디자인 리뷰어']]);
  state = step(state, '@디자', { composing: false });
  assert.equal(state.open, true);
});

test('state: arrows wrap, Escape keeps this @ closed until another @ is typed', () => {
  let state = step(emptyMention(), '@');
  assert.equal(moveMention(state, -1).index, 3);
  assert.equal(moveMention(moveMention(state, -1), 1).index, 0);
  assert.equal(moveMention(emptyMention(), 1).index, 0);
  state = dismissMention(state);
  assert.deepEqual([state.open, state.dismissedStart, state.items.length], [false, 0, 0]);
  state = step(state, '@R');
  assert.equal(state.open, false, 'the dismissed @ stays closed while it is still being typed');
  state = step(state, '@R', { active: false });
  state = step(state, '@R');
  assert.equal(state.open, false, 'a redraw that briefly drops focus does not reopen it');
  state = step(state, '@Rio 그리고 @');
  assert.deepEqual([state.open, state.start, state.dismissedStart], [true, 9, null]);
});

// ------------------------------------------------------------------ choosing

test('choose: @이름 and one space replace what was typed, and the caret lands after the space', () => {
  const state = step(emptyMention(), '안녕 @디');
  assert.deepEqual(applyMention('안녕 @디', state, '디자인 리뷰어'), { text: '안녕 @디자인 리뷰어 ', caret: 12 });
  const middle = nextMention(emptyMention(), { names, text: '@R 확인해줘', caret: 2 });
  assert.deepEqual(applyMention('@R 확인해줘', middle, 'Rio'), { text: '@Rio 확인해줘', caret: 5 }, 'an existing space is reused');
  const tight = nextMention(emptyMention(), { names, text: '@R.', caret: 2 });
  assert.deepEqual(applyMention('@R.', tight, 'Rio'), { text: '@Rio .', caret: 5 });
  assert.deepEqual(applyMention('abc', emptyMention(), 'Rio'), { text: 'abc', caret: 3 }, 'nothing open: nothing changes');
});

test('choose: what is inserted is what the sent bubble reads as a call', () => {
  for (const name of names) {
    const { text } = applyMention('@', step(emptyMention(), '@'), name);
    const spans = mentionSpans(`${text}확인 부탁`, { agentNames: threadAgentNames(board) });
    assert.deepEqual(spans.map(span => [span.kind, span.name]), [[name === '나' ? 'user' : 'agent', name]]);
  }
});

// ------------------------------------------------------------------ keys

test('keys: with the list open ↑↓ move, Enter and Tab choose, Escape closes; otherwise the key is the editor\'s', () => {
  const key = (fields, open = true) => mentionKeyAction(fields, open);
  assert.equal(key({ key: 'ArrowDown' }), 'next');
  assert.equal(key({ key: 'ArrowUp' }), 'prev');
  assert.equal(key({ key: 'Enter' }), 'pick');
  assert.equal(key({ key: 'Tab' }), 'pick');
  assert.equal(key({ key: 'Escape' }), 'close');
  for (const fields of [{ key: 'Enter', shiftKey: true }, { key: 'Tab', shiftKey: true }, { key: 'Enter', isComposing: true },
    { key: 'Enter', keyCode: 229 }, { key: 'ArrowDown', isComposing: true }, { key: 'Enter', ctrlKey: true }, { key: 'Enter', metaKey: true },
    { key: 'ArrowDown', altKey: true }, { key: 'a' }, { key: 'ArrowLeft' }]) assert.equal(key(fields), null, JSON.stringify(fields));
  for (const name of ['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape']) assert.equal(key({ key: name }, false), null);
  assert.equal(MENTION_LIST_LABEL, '부를 대상');
});

// ------------------------------------------------------------------ the production list on a fake composer

const surfaceSource = fs.readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const surfaceCss = fs.readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');

class FakeNode {
  constructor(tag, document) {
    this.tag = tag; this.ownerDocument = document; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {};
    this.hidden = false; this.isConnected = true; this.scrollTop = 0; this.clientHeight = 56; this.offsetTop = 0; this.offsetHeight = 28;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'hidden') this.hidden = true; if (name === 'id') this.id = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(type, handler) { (this.listeners[type] ||= []).push(handler); }
  fire(type, event = {}) {
    const ev = { type, target: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...event };
    for (const handler of this.listeners[type] || []) handler(ev);
    return ev;
  }
  appendChild(child) { this.children.push(child); return child; }
  replaceChildren(...children) { this.children = children; children.forEach((child, index) => { child.offsetTop = index * 28; }); }
  get textContent() { return this.text ?? this.children.map(child => child.textContent).join(''); }
}

function mentionHarness({ thread = board, value = '', memory = {} } = {}) {
  const document = { activeElement: null, createElement: tag => new FakeNode(tag, document), createTextNode: text => ({ textContent: text, text }) };
  const start = surfaceSource.indexOf('  function mountComposerMention(');
  const end = surfaceSource.indexOf('\n  }\n', start);
  assert.ok(start >= 0 && end > start, 'production @ list');
  const elStart = surfaceSource.indexOf('  function el(tag, props = {}, ...children) {');
  const elSource = surfaceSource.slice(elStart, surfaceSource.indexOf('\n  }\n', elStart) + 4);
  const mount = vm.runInNewContext(`(function (document, ChatComposer, SELF_MEMBER) {\n${elSource}\n${surfaceSource.slice(start, end + 4)}\nreturn mountComposerMention; })`)(
    document, { MENTION_LIST_LABEL, mentionNames, emptyMention, nextMention, moveMention, dismissMention, applyMention, mentionKeyAction }, '나');
  const changes = [];
  const attach = (text = value) => {
    const input = new FakeNode('textarea', document);
    input.value = text; input.selectionStart = input.selectionEnd = text.length;
    input.setSelectionRange = (from, to) => { input.selectionStart = from; input.selectionEnd = to; };
    document.activeElement = input;
    const mention = mount(input, thread, memory, { onChange: () => changes.push(input.value) });
    return { input, mention, menu: mention?.menu || null };
  };
  const type = (h, text) => { h.input.value = text; h.input.selectionStart = h.input.selectionEnd = text.length; return h.input.fire('input'); };
  const rows = h => h.menu.children.map(row => [row.textContent, row.getAttribute('aria-selected')]);
  return { document, memory, changes, attach, type, rows };
}

test('screen: @ in a Board Thread lists the room; ↓ and Enter put the name in the draft without sending', () => {
  const h = mentionHarness(), c = h.attach();
  assert.equal(c.menu.getAttribute('role'), 'listbox');
  assert.equal(c.menu.getAttribute('aria-label'), '부를 대상');
  assert.equal(c.menu.hidden, true);
  assert.deepEqual(['aria-controls', 'aria-haspopup', 'aria-autocomplete'].map(name => c.input.getAttribute(name)), [c.menu.id, 'listbox', 'list']);
  assert.equal(c.input.getAttribute('aria-activedescendant'), null);
  assert.equal(c.input._mentionKeydown({ key: 'Enter' }), false, 'no list: Enter stays the send key');
  h.type(c, '@');
  assert.equal(c.menu.hidden, false);
  assert.deepEqual(h.rows(c), [['@코덱스 어시스턴트Agent', 'true'], ['@디자인 리뷰어Agent', 'false'], ['@RioAgent', 'false'], ['@나대표님', 'false']]);
  assert.equal(c.input.getAttribute('aria-activedescendant'), c.menu.children[0].id);
  const down = { key: 'ArrowDown', preventDefault() { this.prevented = true; }, stopPropagation() {} };
  assert.equal(c.input._mentionKeydown(down), true);
  assert.equal(down.prevented, true);
  assert.deepEqual(h.rows(c).map(row => row[1]), ['false', 'true', 'false', 'false']);
  assert.equal(c.input.getAttribute('aria-activedescendant'), c.menu.children[1].id);
  const enter = { key: 'Enter', preventDefault() { this.prevented = true; }, stopPropagation() {} };
  assert.equal(c.input._mentionKeydown(enter), true, 'Enter chooses; the composer must not send');
  assert.equal(enter.prevented, true);
  assert.equal(c.input.value, '@디자인 리뷰어 ');
  assert.deepEqual([c.input.selectionStart, c.input.selectionEnd], [9, 9]);
  assert.deepEqual(h.changes, ['@디자인 리뷰어 '], 'the draft and the composer height hear about it once');
  assert.equal(c.menu.hidden, true);
  assert.equal(c.input.getAttribute('aria-activedescendant'), null);
  assert.equal(c.input._mentionKeydown({ key: 'Enter' }), false, 'the next Enter sends');
});

test('screen: Tab and a click choose too; the click keeps the caret in the draft', () => {
  const h = mentionHarness(), c = h.attach();
  h.type(c, '검토 @R');
  assert.deepEqual(h.rows(c), [['@RioAgent', 'true']]);
  assert.equal(c.input._mentionKeydown({ key: 'Tab', preventDefault() {}, stopPropagation() {} }), true);
  assert.equal(c.input.value, '검토 @Rio ');
  h.type(c, '검토 @Rio @');
  const row = c.menu.children[3];
  assert.equal(row.fire('mousedown').defaultPrevented, true, 'the composer keeps focus');
  row.fire('click');
  assert.equal(c.input.value, '검토 @Rio @나 ');
  assert.equal(c.menu.hidden, true);
});

test('screen: Escape closes only the list and is not passed on; leaving the composer hides it', () => {
  const h = mentionHarness(), c = h.attach();
  h.type(c, '@');
  const escape = { key: 'Escape', preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
  assert.equal(c.input._mentionKeydown(escape), true);
  assert.deepEqual([escape.prevented, escape.stopped], [true, true], 'the Chat behind it stays open');
  assert.equal(c.menu.hidden, true);
  assert.equal(c.input.value, '@');
  h.type(c, '@R');
  assert.equal(c.menu.hidden, true, 'this @ stays closed');
  assert.equal(c.input._mentionKeydown({ key: 'Escape' }), false, 'with no list Escape belongs to the Chat');
  h.type(c, '@R @');
  assert.equal(c.menu.hidden, false);
  c.input.fire('blur');
  assert.equal(c.menu.hidden, true);
  h.document.activeElement = c.input;
  c.input.fire('keyup', { key: 'ArrowLeft' });
  assert.equal(c.menu.hidden, false, 'coming back to the same @ shows it again');
});

test('screen: Korean composition does not open the list and its Enter is never taken', () => {
  const h = mentionHarness(), c = h.attach();
  c.input.fire('compositionstart');
  h.type(c, '@디');
  assert.equal(c.menu.hidden, true);
  assert.equal(c.input._mentionKeydown({ key: 'Enter', isComposing: true }), false);
  c.input.fire('compositionend');
  assert.equal(c.menu.hidden, false, 'the finished syllable narrows the list');
  assert.deepEqual(h.rows(c), [['@디자인 리뷰어Agent', 'true']]);
  c.input.fire('compositionstart');
  h.type(c, '@디자');
  assert.equal(c.menu.hidden, false, 'an open list keeps narrowing while the next syllable is composed');
  assert.equal(c.input._mentionKeydown({ key: 'Enter', isComposing: true, keyCode: 229 }), false, 'the syllable keeps its Enter');
});

test('screen: a redraw of the Chat keeps the open list and its highlighted row; an Agent DM has no list', () => {
  const h = mentionHarness(), first = h.attach();
  h.type(first, '@');
  first.input._mentionKeydown({ key: 'ArrowDown', preventDefault() {}, stopPropagation() {} });
  first.input.isConnected = false;
  first.input.fire('blur');
  const second = h.attach('@');
  assert.equal(second.menu.hidden, true, 'nothing shows until the caret is back');
  second.input._syncMention();
  assert.equal(second.menu.hidden, false);
  assert.deepEqual(h.rows(second).map(row => row[1]), ['false', 'true', 'false', 'false']);
  const direct = mentionHarness({ thread: dm }).attach('@');
  assert.equal(direct.mention, null);
  assert.equal(direct.input._mentionKeydown, undefined);
  assert.equal(direct.input.getAttribute('aria-controls'), null);
});

test('wiring: the composer mounts the list for its room, redraws resync it, and styles use tokens', () => {
  assert.match(surfaceSource, /const mention = mountComposerMention\(input, activeThread, body\._composerMention \|\|= \{\}, \{\n\s+onChange: \(\) => \{ codexBridge\.setDraft\(input\.value, activeThread\.id\); resizeComposer\(false\); \},\n\s+\}\);/);
  assert.match(surfaceSource, /newInput\.setSelectionRange\(inputState\.start, inputState\.end, inputState\.direction\);\n\s+newInput\._syncMention\?\.\(\);/);
  assert.match(surfaceSource, /if \(input\._mentionKeydown\?\.\(ev\)\) return;\n\s+if \(ev\.key !== 'Enter' \|\| ev\.shiftKey \|\| ev\.altKey\) return;/);
  assert.match(surfaceSource, /title: `Enter 전송 · Shift\+Enter 줄바꿈\$\{activeThread\.type === 'group' \? ' · @로 Agent 부르기' : ''\}`,/, 'a Board Thread composer says @ calls an Agent');
  assert.match(surfaceSource, /title: item\.kind === 'user' \? '나를 가리키는 이름을 넣습니다' : `\$\{item\.name\}에게 말합니다\. 부른 Agent만 답합니다\.`/);
  const rule = selector => surfaceCss.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]+)\\}`, 'm'))?.[1] || '';
  assert.match(rule('.egd-codex-mention-menu'), /position: absolute;[^}]*bottom: 100%;[^}]*background: var\(--egd-surface-elevated\);[^}]*box-shadow: var\(--egd-shadow\);/);
  assert.match(rule('.egd-codex-mention-menu[hidden]'), /display: none;/);
  assert.match(rule('.egd-codex-mention-option:hover'), /background: var\(--egd-hover\);/);
  assert.match(rule('.egd-codex-mention-option[aria-selected="true"]'), /background: var\(--egd-primary-container\);/);
  for (const selector of ['.egd-codex-mention-menu', '.egd-codex-mention-option', '.egd-codex-mention-option-hint']) {
    assert.doesNotMatch(rule(selector), /#[0-9a-f]{3,8}\b|rgba?\(/i, `${selector} uses tokens only`);
  }
});
