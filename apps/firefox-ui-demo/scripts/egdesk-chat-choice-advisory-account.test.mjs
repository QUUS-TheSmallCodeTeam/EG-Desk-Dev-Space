import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import * as AccountSettingsView from '../overlay/resources/EGDeskAccountSettingsView.sys.mjs';
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';

// No prebuilt Settings/control nodes: only the document, mount point and DM draft
// are furnished. All account contents and shell actions come from Surface source.
function documentFixture() {
  const doc = { activeElement: null };
  function events() {
    const handlers = new Map();
    return {
      addEventListener(type, fn) { if (!handlers.has(type)) handlers.set(type, new Set()); handlers.get(type).add(fn); },
      removeEventListener(type, fn) { handlers.get(type)?.delete(fn); },
      fire(type, target = this) { for (const fn of handlers.get(type) || []) fn({ type, target, currentTarget: this, stopPropagation() {}, preventDefault() {} }); },
    };
  }
  function node(tag, text = '') {
    const attrs = new Map();
    const n = { ...events(), tag, dataset: {}, children: [], parent: null, style: {}, className: '', hidden: false,
      setAttribute(k, v) { attrs.set(k, String(v)); },
      getAttribute(k) { return k.startsWith('data-') ? this.dataset[k.slice(5).replace(/-([a-z])/g, (_, m) => m.toUpperCase())] : attrs.get(k); },
      get id() { return this.getAttribute('id'); }, get disabled() { return attrs.has('disabled'); },
      get isConnected() { return this === doc.documentElement || !!this.parent?.isConnected; },
      appendChild(child) { child.remove(); child.parent = this; this.children.push(child); return child; },
      replaceChildren(...children) { for (const old of [...this.children]) old.remove(); text = ''; for (const child of children) this.appendChild(child); },
      remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; },
      contains(other) { return other === this || this.children.some(child => child.contains(other)); },
      get textContent() { return text + this.children.map(child => child.textContent).join(''); },
      set textContent(value) { this.replaceChildren(); text = value; },
      matches(selectors) { return selectors.split(',').some(selector => {
        const parsed = /^(?:([\w-]+)|\.([\w-]+)|#([\w-]+))?((?:\[[\w-]+="[^"]*"\])*)$/.exec(selector.trim());
        assert.ok(parsed, `unimplemented selector: ${selector}`);
        const [, tag, cls, id, filters] = parsed;
        return (!tag || this.tag === tag) && (!cls || this.classList.contains(cls)) && (!id || this.id === id)
          && [...filters.matchAll(/\[([\w-]+)="([^"]*)"\]/g)].every(([, key, value]) => this.getAttribute(key) === value);
      }); },
      querySelectorAll(selector) { return this.children.flatMap(child => [...(child.tag !== '#text' && child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); },
      querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
      focus() { if (this.isConnected && !this.disabled) doc.activeElement = this; },
      blur() { if (doc.activeElement === this) doc.activeElement = null; },
      scrollIntoView() { assert.ok(this.isConnected); this.scrolled = true; },
      click() { assert.ok(this.isConnected && !this.hidden && !this.disabled, 'connected actionable product control'); this.fire('click'); },
    };
    n.classList = {
      contains: key => n.className.split(/\s+/).includes(key),
      toggle(key, enabled) { const parts = new Set(n.className.split(/\s+/).filter(Boolean)); if (enabled) parts.add(key); else parts.delete(key); n.className = [...parts].join(' '); },
      add(...keys) { for (const key of keys) this.toggle(key, true); },
      remove(...keys) { for (const key of keys) this.toggle(key, false); },
    };
    return n;
  }
  doc.documentElement = node('html');
  return Object.assign(doc, events(), { createElement: node, createTextNode: text => node('#text', text),
    getElementById: id => doc.documentElement.querySelector(`#${id}`), querySelectorAll: selector => doc.documentElement.querySelectorAll(selector) });
}

const source = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
function slice(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const fragments = [
  ['  function el(tag,', '  function svgEl('],
  ['  function normalizeSourcePart(', '\n  function '],
  ['  function sourceRefKey(', '  function browserSourceRef('],
  ['  function singletonSourceRef(', '  function normalizeOpenMode('],
  ['  function setActiveEntity(', '  function setSelectedEntities('],
  ['  function focusCanvasCard(', '  // CU-05:'],
  ['  function revealOpenCanvasCard(', '  // \'채팅에서 보기\':'],
  ['  function chatChoiceExplanationDraft(', '  function mountCodexHUD('],
  ['  function settingsProfileAccountKey(', '  function createSettingsProfileTransfer('],
  ['  function spawnSettingsCard(', '  function resolveBrowserCard('],
  ['  function codexBridgeNotice(', '  function codexBridgeSummary('],
].map(pair => slice(...pair)).join('\n');
const bridgeMethods = slice('      chatChoiceScope(', '      createProfileTransferScope(');
const hudMount = slice('    const choice = mountChatChoiceComposer({ el,', '    let focusOpenedRoom = false;');

const settle = () => new Promise(resolve => setImmediate(resolve));
const one = (parent, selector) => { const hits = parent.querySelectorAll(selector); assert.equal(hits.length, 1, selector); return hits[0]; };

// Exercise the case only in the project's explicit, no-network/no-fork QA run.
const offline = process.env.EGDESK_QA_CHOICE_VERIFY_ISOLATION === '1';
test('advisory account handoff renders product Settings and restores same-DM edits without a write or send',
  { skip: !offline && 'requires the EG-Desk offline QA runner' }, async t => {
  const allowed = ['__CF_USER_TEXT_ENCODING', 'NODE_TEST_WORKER_ID', 'HOME', 'CFFIXED_USER_HOME', 'TMPDIR', 'PATH',
    'EGDESK_QA_CHOICE_VERIFY_ISOLATION', 'EGDESK_CODEX_BIN', 'EGDESK_CLAUDE_BIN'];
  assert.deepEqual(Object.keys(process.env).filter(key => !allowed.includes(key)), []);
  assert.ok(process.permission, 'Node --permission is required');
  for (const scope of ['net', 'child', 'worker']) assert.equal(process.permission.has(scope), false);
  const document = documentFixture();
  const host = document.documentElement.appendChild(document.createElement('main'));
  host.setAttribute('id', 'egd-canvas-layer');
  const question = '  Cafe\u0301와 어느 일정이 맞나요? ';
  const options = ['  Cafe\u0301에서 오전 일정 ', ' 오후 일정  '];
  const profile = { id: 'review-verifier', origin: 'template', revision: 1 };
  const auth = { isLoggedIn: true, authMode: 'chatgpt', accountId: 'synthetic-account' };
  const accountKey = ChatState.codexAccountKey(auth);
  const room = { id: 'room', type: 'dm', engineId: 'codex', profileEnabled: true, agentProfileId: profile.id,
    bindingAccountKey: accountKey, bindingState: 'verified', conversationId: 'synthetic-dm', agent: { profileId: profile.id, revision: 1 } };
  const state = { sourceRefs: { cardsByKey: {} }, codex: { activeThreadId: room.id, hudView: 'conversation', authStatus: auth, connected: true,
    threadDraftRevisions: { room: 0 }, activityRoomGeneration: 1 }, contextSuggest: { byThread: {} } };
  const calls = { chooserGet: [], accountGet: 0, chooserPost: 0, nativeSend: 0, write: 0, other: 0 };
  const status = Object.freeze({ configured: true, mode: 'advisory', boardRevision: 'b'.repeat(64) });
  const notices = [], dirty = [], reveal = [];
  let subscriptions = 0;
  const ctx = {
    state, document, AccountSettingsView, ChatState, console, cardSeq: 0, cardZ: 0,
    protocol: ChatState.createChatProtocolState(), choiceSettingsWriting: 0, choiceSettingsGeneration: 0,
    getCodexThreadById: (_, id) => id === room.id ? room : null, getCodexThreadDraft: () => question,
    codexThreadAgentProfile: () => profile, CODEX_AGENT_PROFILES: { [profile.id]: {} },
    threadBusy: () => false, chatRoomProjectState: () => ({ status: 'ready', value: { status: 'none' } }),
    chatProjectDraftActions: new Map(), manualOwnerIdentity: () => accountKey,
    window: { AbortController, crypto: { randomUUID: () => assert.fail('no choice request ID allocated') } },
    SurfaceState: { bridgeConnectionNotice: () => ({ state: 'online' }) },
    boardNotice: message => notices.push(message),
    deskIcon: () => document.createElement('i'), isCardFullscreen: () => false, installCardHeaderFullscreenToggle() {},
    createSettingsProfileTransfer: () => ({ dispose() {} }), // unvisited Agent tab/native picker seam
    resolveCanvasCardPlacement: () => ({ x: 0, y: 0, width: 500, height: 400 }),
    persistentEntityGeometry: () => ({ x: 0, y: 0, width: 500, height: 400 }),
    safeViewportWorldRect: () => ({ left: 0, right: 600, top: 0, bottom: 500 }),
    revealPlacedCanvasCard: (card, _, options) => { assert.ok(card.isConnected); reveal.push(options?.isCurrent?.() ?? 'spawn'); },
    markAgendaDirty: reason => dirty.push(reason), syncViewportAgendaRail() {},
    fetchJson: async (path, init) => {
      if (path === '/chat/choice') { calls.chooserPost++; throw Error('unexpected choice POST'); }
      if (path === '/chat/send') { calls.nativeSend++; throw Error('unexpected native send'); }
      assert.equal(path, '/decision/status');
      assert.equal(init.method, 'GET'); assert.equal(init.cache, 'no-store'); assert.equal('body' in init, false);
      calls.chooserGet.push(init.signal);
      if (calls.chooserGet.length === 1) throw Error('synthetic local refusal');
      return status;
    },
    fetch: async (url, init) => {
      if (init.method !== 'GET') { calls.write++; throw Error('unexpected Settings write'); }
      if (url !== 'http://127.0.0.1:39218/decision/status') { calls.other++; throw Error('unexpected request'); }
      assert.equal('body' in init, false); calls.accountGet++;
      return { ok: true, json: async () => status };
    },
    emit: () => assert.fail('settings write began'),
  };
  const { choice, el, codexBridge } = runInNewContext(`${fragments}\nconst codexBridge = {${bridgeMethods}};\n${hudMount}\n({choice, el, codexBridge})`, ctx);
  state.codexBridge = Object.assign(codexBridge, {
    subscribe: () => { subscriptions++; return () => { subscriptions--; }; },
    sendMessage: () => { calls.nativeSend++; assert.fail('native composer send must stay idle'); },
  });
  const input = el('textarea'); input.value = question;
  host.appendChild(el('div', { id: 'fixture-dm' }, input, choice.trigger, choice.panel));
  choice.attach({ input, readScope: () => codexBridge.chatChoiceScope(room.id, input.value), setDraft: () => assert.fail('unexpected draft replacement') });
  choice.sync();
  const field = suffix => `[data-testid="chat-choice-${suffix}"]`;
  const choiceButton = suffix => one(choice.panel, field(suffix));
  const fields = () => choice.panel.querySelectorAll(field('option'));
  const counts = (chooserGet, accountGet) => {
    assert.deepEqual([calls.chooserGet.length, calls.accountGet, calls.chooserPost, calls.nativeSend, calls.write, calls.other], [chooserGet, accountGet, 0, 0, 0, 0]);
    assert.equal(input.value, question); assert.equal(state.codex.activeThreadId, room.id);
    assert.equal(choice.panel.querySelector(field('confirm')), null);
    assert.equal(choice.panel.querySelector(field('result')), null);
  };

  const before = codexBridge.chatChoiceScope(room.id, input.value);
  assert.ok(before?.editKey);
  assert.equal(document.querySelectorAll('.egd-settings-card').length, 0);
  assert.equal(choice.trigger.textContent, '보기 추천'); choice.trigger.click();
  assert.equal(fields().length, 2);
  fields().forEach((node, i) => { node.value = options[i]; node.fire('input'); });
  choiceButton('review').click(); await settle();
  assert.match(choice.panel.querySelector('[role="status"]').textContent, /질문과 보기를 보내지 않았습니다/);
  counts(1, 0); assert.equal(choiceButton('cancel').textContent, '닫기'); choiceButton('cancel').click();
  assert.ok(choice.panel.hidden); assert.equal(calls.chooserGet[0].aborted, true);
  choice.trigger.click(); assert.deepEqual(fields().map(node => node.value), options); counts(1, 0);
  choiceButton('review').click(); await settle();
  assert.match(choice.panel.querySelector('[role="status"]').textContent, /‘기록만’ 모드입니다/);
  counts(2, 0);
  const settings = choiceButton('settings'); assert.equal(settings.textContent, '계정 설정 열기'); settings.click();
  assert.equal(calls.chooserGet[1].aborted, true); assert.ok(choice.panel.hidden);
  const card = one(document.documentElement, '.egd-settings-card');
  assert.equal(state.activeEntityId, card.id);
  const whileInSettings = codexBridge.chatChoiceScope(room.id, input.value);
  assert.equal(whileInSettings?.editKey, before.editKey);
  assert.notEqual(whileInSettings.key, before.key, 'canvas focus changes approval scope, not edit ownership');
  assert.equal(one(card, '[data-testid="settings-tab-account"][aria-selected="true"]').textContent, '계정');
  assert.equal(one(card, '[data-testid="settings-decision"]').scrolled, true, 'handoff scrolls the product-created section');
  await settle();
  const section = one(card, '[data-testid="settings-decision"][data-mode="advisory"]');
  assert.equal(one(section, '.egd-settings-section-title').textContent, '결정 모델 · OpenAI Decisions');
  assert.equal(one(section, '[data-testid="settings-decision-mode"][data-mode="advisory"][role="radio"][aria-checked="true"]').textContent, '기록만');
  assert.equal(one(section, 'input[type="password"][data-testid="settings-decision-key"]').disabled, false);
  const save = one(section, 'button[data-testid="settings-decision-save"]');
  assert.equal(save.textContent, '확인 후 저장'); assert.equal(save.disabled, false);
  assert.deepEqual(reveal, ['spawn', true]); assert.deepEqual(notices, []); assert.equal(subscriptions, 1);
  counts(2, 1);
  one(card, '[role="button"][aria-label="창 닫기"]').click();
  assert.equal(card.isConnected, false); assert.equal(state.activeEntityId, null); assert.equal(subscriptions, 0);
  assert.deepEqual(Object.keys(state.sourceRefs.cardsByKey), []);
  assert.deepEqual(dirty, ['create-settings-card', 'close-card']);
  // No test-driven HUD refresh after closing: click the still-mounted DM trigger below.
  assert.equal(choice.trigger.isConnected, true);
  assert.equal(choice.trigger.disabled, false);
  for (let node = choice.trigger; node; node = node.parent) assert.notEqual(node.hidden, true);
  const after = codexBridge.chatChoiceScope(room.id, input.value);
  assert.equal(after?.editKey, before.editKey);
  assert.notEqual(after.key, whileInSettings.key);
  choice.trigger.click(); assert.deepEqual(fields().map(node => node.value), options);
  await settle(); counts(2, 1);
  t.diagnostic('product-generated account tab, advisory radio, password input type, save and window close verified');
  t.diagnostic('same DM: raw composer and both raw options retained; no confirm/result; chooser GET=2 (first rejected); account GET=1; choice POST=0; native send=0; setting writes=0');
});
