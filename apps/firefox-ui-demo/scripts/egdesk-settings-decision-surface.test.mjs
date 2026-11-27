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
// Browsers move focus to the body when the focused element leaves the document; the fixture does not, so do it here.
{ const doc0 = null; }
async function mount({ mode = 'on', configured = true, savedKey = true } = {}) {
  const document = documentFixture();
  // browser behaviour: removing the focused element (or its ancestor) drops focus
  const origCreate = document.createElement;
  document.createElement = tag => { const n = origCreate(tag); const rm = n.remove; n.remove = function () { if (document.activeElement && this.contains(document.activeElement)) document.activeElement = null; return rm.call(this); }; return n; };
  const host = document.documentElement.appendChild(document.createElement('main'));
  host.setAttribute('id', 'egd-canvas-layer');
  const question = '어느 일정이 맞나요?';
  const options = ['오전 일정', '오후 일정'];
  const profile = { id: 'review-verifier', origin: 'template', revision: 1 };
  const auth = { isLoggedIn: true, authMode: 'chatgpt', accountId: 'synthetic-account' };
  const accountKey = ChatState.codexAccountKey(auth);
  const room = { id: 'room', type: 'dm', engineId: 'codex', profileEnabled: true, agentProfileId: profile.id,
    bindingAccountKey: accountKey, bindingState: 'verified', conversationId: 'synthetic-dm', agent: { profileId: profile.id, revision: 1 } };
  const state = { sourceRefs: { cardsByKey: {} }, codex: { activeThreadId: room.id, hudView: 'conversation', chatCapabilities: ['choice'], authStatus: auth, connected: true,
    threadDraftRevisions: { room: 0 }, activityRoomGeneration: 1 }, contextSuggest: { byThread: {} } };
  const server = { configured, mode, keyHint: savedKey ? '…WXYZ' : null, boardRevision: 'b'.repeat(64), posts: [], choicePosts: 0, scenario: 'verified', externalWriteWaits: 0 };
  const statusBody = () => ({ configured: server.configured, mode: server.mode, store: server.configured ? 'configured' : 'missing', keyHint: server.keyHint, savedAt: 1, model: 'gpt-6-luna', boardRevision: server.boardRevision, budget: { month: '2026-11', inputTokens: 0, cap: null } });
  const listeners = new Set(); const notices = []; let choice = null;
  const ctx = {
    state, document, AccountSettingsView, ChatState, console, cardSeq: 0, cardZ: 0,
    protocol: ChatState.createChatProtocolState(), choiceSettingsWriting: 0, choiceSettingsGeneration: 0,
    getCodexThreadById: (_, id) => id === room.id ? room : null, getCodexThreadDraft: () => ctx.draft,
    codexThreadAgentProfile: () => profile, CODEX_AGENT_PROFILES: { [profile.id]: {} },
    threadBusy: () => false, chatRoomProjectState: () => ({ status: 'ready', value: { status: 'none' } }),
    chatProjectDraftActions: new Map(), manualOwnerIdentity: () => accountKey,
    window: { AbortController, crypto: { randomUUID: () => 'uuid' }, setTimeout, clearTimeout },
    SurfaceState: { bridgeConnectionNotice: () => ({ state: 'online' }) },
    boardNotice: message => notices.push(message),
    deskIcon: () => document.createElement('i'), isCardFullscreen: () => false, installCardHeaderFullscreenToggle() {},
    createSettingsProfileTransfer: () => ({ dispose() {}, sync() {} }),
    resolveCanvasCardPlacement: () => ({ x: 0, y: 0, width: 500, height: 400 }),
    persistentEntityGeometry: () => ({ x: 0, y: 0, width: 500, height: 400 }),
    safeViewportWorldRect: () => ({ left: 0, right: 600, top: 0, bottom: 500 }),
    revealPlacedCanvasCard: () => {}, markAgendaDirty() {}, syncViewportAgendaRail() {},
    draft: question,
    fetchJson: async (path, init) => {
      if (path === '/chat/choice') { server.choicePosts++; return { status: 'recommended', index: 0 }; }
      if (path === '/decision/status') return statusBody();
      throw Error(`unexpected fetchJson ${path}`);
    },
    fetch: async (url, init) => {
      const path = new URL(url).pathname; const body = init.body ? JSON.parse(init.body) : null; const reply = (status, data) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
      await settle();
      if (path === '/decision/status') return reply(200, statusBody());
      if (path === '/decision/mode' && init.method === 'POST') { server.mode = body.mode; server.posts.push(`mode:${body.mode}`); return reply(200, { mode: server.mode }); }
      if (path === '/decision/credential' && init.method === 'DELETE') { server.configured = false; server.keyHint = null; server.posts.push('delete'); return reply(200, statusBody()); }
      if (path === '/decision/credential' && init.method === 'POST') {
        server.posts.push(`save:${body.apiKey}`);
        const sc = server.scenario;
        if (sc === 'verified') { server.configured = true; server.keyHint = `…${body.apiKey.slice(-4)}`; return reply(200, { ...statusBody(), verification: 'verified' }); }
        if (sc === 'rate_limited') { server.configured = true; server.keyHint = `…${body.apiKey.slice(-4)}`; return reply(200, { ...statusBody(), verification: 'rate_limited' }); }
        if (sc === 'invalid_key') return reply(422, { code: 'DECISION_KEY_REJECTED', verification: 'invalid_key', error: 'x' });
        if (sc === 'unreachable') return reply(422, { code: 'DECISION_KEY_REJECTED', verification: 'unreachable', error: 'x' });
        if (sc === 'not_replaced') return reply(422, { code: 'DECISION_KEY_NOT_REPLACED', verification: 'no_credit', error: 'x' });
        if (sc === 'bridge_down') throw Error('down');
      }
      throw Error(`unexpected ${init.method} ${path}`);
    },
    emit: () => { for (const f of [...listeners]) f(state.codex); choice?.sync(); },
  };
  const extra = `;\nconst codexBridge = {${bridgeMethods}};\n${hudMount}\n({choice, el, codexBridge, openChatChoiceSettings})`;
  const out = runInNewContext(`${fragments}${extra}`, ctx);
  choice = out.choice;
  state.codexBridge = Object.assign(out.codexBridge, { subscribe: f => { listeners.add(f); return () => listeners.delete(f); }, sendMessage() { throw Error('no send'); } });
  const input = out.el('textarea'); input.value = question;
  host.appendChild(out.el('div', { id: 'fixture-dm' }, input, choice.trigger, choice.panel));
  choice.attach({ input, readScope: () => state.codexBridge.chatChoiceScope(room.id, input.value), setDraft: () => {} });
  choice.sync();
  return { document, state, server, choice, input, ctx, notices, options, openSettings: out.openChatChoiceSettings, codexBridge: state.codexBridge };
}
const text = n => n?.textContent ?? null;
const q = (root, sel) => root.querySelector(sel);
const settingsCard = m => q(m.document.documentElement, '.egd-settings-card');
const drain = async () => { for (let i = 0; i < 8; i++) await settle(); };

// Mounted real surface code (Settings account tab, DM chooser composer) over a fake DOM and a fake bridge.
// Not the installed app: no Firefox, no network, no real focus manager.
for (const [scenario, hasKey, role, saved] of [['verified', false, 'status', true], ['rate_limited', false, 'status', true],
  ['invalid_key', false, 'alert', false], ['unreachable', false, 'alert', false], ['not_replaced', true, 'alert', true], ['bridge_down', false, 'alert', false]]) {
  test(`key save (${scenario}): focus returns to the key field, the secret is not kept, the result is a live region`, async () => {
    const m = await mount({ mode: 'on', configured: hasKey, savedKey: hasKey });
    m.openSettings('key'); await drain();
    const card = settingsCard(m);
    m.server.scenario = scenario;
    const first = q(card, '[data-testid="settings-decision-key"]');
    first.focus(); first.value = 'egd-synthetic-new-key-0003-BBBB';
    q(card, '[data-testid="settings-decision-save"]').click(); await drain();
    const field = q(card, '[data-testid="settings-decision-key"]');
    assert.equal(m.document.activeElement, field, 'focus is on the key field, not the page');
    assert.equal(field.value ?? '', '', 'a secret is never left in the field, success or failure');
    const result = q(card, '[data-testid="settings-decision-result"]');
    assert.equal(result.getAttribute('role'), role);
    assert.equal(field.getAttribute('aria-describedby'), role === 'alert' ? result.id : undefined);
    assert.equal(q(card, '[data-testid="settings-decision-mode"][aria-checked="true"]').getAttribute('data-mode'), 'on', 'mode untouched');
    assert.equal(text(q(card, '[data-testid="settings-decision-hint"]')).includes('BBBB'), saved && scenario !== 'not_replaced');
  });
}
test('focus the person moved elsewhere during a save is not taken back', async () => {
  const m = await mount({ mode: 'on', configured: false, savedKey: false });
  m.openSettings('key'); await drain();
  const card = settingsCard(m); m.server.scenario = 'verified';
  const field = q(card, '[data-testid="settings-decision-key"]'); field.focus(); field.value = 'egd-synthetic-new-key-0003-BBBB';
  q(card, '[data-testid="settings-decision-save"]').click();
  const elsewhere = m.input; elsewhere.focus();
  await drain();
  assert.equal(m.document.activeElement, elsewhere);
});

async function recommended() {
  const m = await mount({ mode: 'on', configured: true, savedKey: true });
  m.choice.trigger.click();
  m.choice.panel.querySelectorAll('[data-testid="chat-choice-option"]').forEach((n, i) => { n.value = m.options[i]; n.fire('input'); });
  q(m.choice.panel, '[data-testid="chat-choice-review"]').click(); await settle(); await settle();
  q(m.choice.panel, '[data-testid="chat-choice-confirm"]').click(); await drain();
  assert.equal(text(q(m.choice.panel, '[data-testid="chat-choice-result"]')), 'EG-Desk 추천: 오전 일정 · 실행하지 않음');
  return m;
}
for (const [label, open, act] of [
  ['on to off', 'mode', card => q(card, '[data-testid="settings-decision-mode"][data-mode="off"]')],
  ['on to advisory', 'mode', card => q(card, '[data-testid="settings-decision-mode"][data-mode="advisory"]')],
  ['key removed', 'key', card => q(card, '[data-testid="settings-decision-delete"]')],
]) {
  test(`a shown recommendation and its [이유 묻기] go inert when settings change (${label}); the typed question stays`, async () => {
    const m = await recommended();
    m.openSettings(open); await drain();
    act(settingsCard(m)).click(); await drain();
    assert.equal(m.choice.panel.hidden, true);
    assert.equal(q(m.choice.panel, '[data-testid="chat-choice-result"]'), null);
    assert.equal(q(m.choice.panel, '[data-testid="chat-choice-explain"]'), null);
    assert.equal(m.input.value, '어느 일정이 맞나요?');
    assert.equal(m.server.choicePosts, 1, 'no new provider request');
  });
}
test('a mode change in another window: [이유 묻기] re-checks and falls back to manual without sending or clearing the question', async () => {
  const m = await recommended();
  m.server.mode = 'off';
  q(m.choice.panel, '[data-testid="chat-choice-explain"]').click(); await drain();
  assert.equal(q(m.choice.panel, '[data-testid="chat-choice-explain"]'), null);
  assert.equal(q(m.choice.panel, '[data-testid="chat-choice-result"]'), null);
  assert.match(text(q(m.choice.panel, '[role="status"]')), /추천을 표시할 수 없습니다/);
  assert.equal(m.input.value, '어느 일정이 맞나요?');
  assert.equal(m.server.choicePosts, 1);
});
