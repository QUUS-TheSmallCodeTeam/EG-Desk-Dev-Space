// CHAT-05 '브리핑 요청': the production button for an answer without a briefing
// writes a fixed request into that room's composer draft and never sends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFunction } from 'node:vm';
import { readSurfaceSource } from './egdesk-surface-source.mjs';
import * as Briefing from '../overlay/resources/EGDeskBriefingState.sys.mjs';
import * as RailSearchView from '../overlay/resources/EGDeskRailSearchView.sys.mjs';

const surfaceSource = readSurfaceSource();
const declaration = name => {
  const start = surfaceSource.indexOf(`  function ${name}(`);
  const end = start < 0 ? -1 : surfaceSource.indexOf('\n  }\n', start);
  return end < 0 ? null : surfaceSource.slice(start, end + 4);
};

function fakeEl(tag, props = {}, ...children) {
  const node = { tagName: tag.toUpperCase(), attributes: {}, dataset: {}, listeners: {}, className: '', textContent: children.filter(Boolean).join(''),
    fire(type) { const event = { type, preventDefault() {}, stopPropagation() {} }; this.listeners[type]?.(event); } };
  for (const [key, value] of Object.entries(props)) {
    if (key === 'data') Object.assign(node.dataset, value);
    else if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.listeners[key.slice(2)] = value;
    else node.attributes[key] = value;
  }
  return node;
}

function harness({ held = false, draft = '' } = {}) {
  const drafts = { room: draft }, sends = [], frames = [];
  const composer = { dataset: { threadId: 'room' }, disabled: false, value: '', focused: false,
    focus() { this.focused = true; }, setSelectionRange(start, end) { this.selection = [start, end]; } };
  const state = { codex: { threadDrafts: drafts }, codexBridge: {
    setDraft(text, threadId) { drafts[threadId] = text; composer.value = text; },
    sendMessage() { sends.push('send'); },
  } };
  const window = { requestAnimationFrame: fn => frames.push(fn) };
  const document = { querySelectorAll: () => [composer] };
  const source = declaration('buildBriefingRequestControl');
  assert.ok(source, 'production buildBriefingRequestControl exists');
  const build = compileFunction(`${source}\nreturn buildBriefingRequestControl;`,
    ['state', 'window', 'document', 'el', 'BriefingState', 'RailSearchView', 'ChatState', 'getCodexThreadDraft'])(
    state, window, document, fakeEl, Briefing, RailSearchView, { nativeBindingHeld: () => held }, (codex, id) => codex.threadDrafts[id] || '');
  return { build, drafts, sends, frames, composer };
}

const thread = { id: 'room', engineId: 'codex', contextToolsAvailable: true };
const answer = { id: 'm1', answerId: 'native/run-1', role: 'assistant', status: 'complete', content: '세 가지 방법을 비교했습니다.' };

test('the 브리핑 요청 button appends the fixed request to the kept draft, focuses the composer and sends nothing', () => {
  const h = harness({ draft: '먼저 쓴 문장' });
  const button = h.build(thread, answer);
  assert.equal(button.textContent, '브리핑 요청');
  assert.equal(button.dataset.testid, 'briefing-request');
  assert.equal(button.dataset.answerId, 'native/run-1');
  assert.match(button.attributes.title, /전송하지 않음/);
  button.fire('click');
  const request = Briefing.briefingRequestOffer(thread, answer).text;
  assert.equal(h.drafts.room, `먼저 쓴 문장\n${request}`);
  button.fire('click');
  assert.equal(h.drafts.room, `먼저 쓴 문장\n${request}`, 'pressing again does not repeat the request');
  h.frames.forEach(fn => fn());
  assert.equal(h.composer.focused, true);
  assert.deepEqual(h.sends, []);
});

test('no 브리핑 요청 for an answer that has a briefing, a held room, or a Claude room', () => {
  const h = harness();
  assert.equal(h.build(thread, { ...answer, briefing: { id: 'b', steps: [{ id: 's', text: 'T', target: { sourceId: 'x' } }] } }), null);
  assert.equal(harness({ held: true }).build(thread, answer), null);
  assert.equal(h.build({ ...thread, engineId: 'claude' }, answer), null);
});

test('the answer row shows 브리핑 보기 when there is a briefing and 브리핑 요청 otherwise', () => {
  assert.match(surfaceSource, /const briefingRequest = briefingControl \? null : buildBriefingRequestControl\(activeThread, message\);/);
  assert.match(surfaceSource, /if \(briefingRequest\) messageStack\.insertBefore\(briefingRequest, meta\?\.parentNode === messageStack \? meta : null\);/);
});
