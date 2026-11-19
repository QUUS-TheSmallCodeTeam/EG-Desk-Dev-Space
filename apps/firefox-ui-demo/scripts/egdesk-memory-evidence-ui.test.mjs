import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as view from '../overlay/resources/EGDeskMemoryEvidence.sys.mjs';
import * as chat from '../overlay/resources/EGDeskChatState.sys.mjs';

const auth = { isLoggedIn: true, accountId: 'test-account', authMode: 'oauth' };
const thread = { type: 'dm', id: 'room', clientBindingId: 'binding', conversationId: 'conversation', profileEnabled: true,
  agentProfileId: 'hana', bindingAccountKey: chat.codexAccountKey(auth), bindingState: 'verified' };
const codex = { activeThreadId: thread.id, hudView: 'conversation', authStatus: auth, connected: true };
const route = { clientThreadId: 'binding', conversationId: 'conversation', expectedProfileId: 'hana' };
const wait = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
const capture = (label, i) => ({ sourceId: `document-${i}`, revision: String(i).repeat(64), label, lineCount: 12345 });
const captures = [capture('장부', 1), capture('전표', 2)];

// Small, network-free DOM implementing the native control events used by the actual view.
class Node {
  constructor(tag, props, children) { Object.assign(this, { tag, props, children: [], listeners: {}, value: props.value || '', content: '' });
    if (props.onclick) this.addEventListener('click', props.onclick); this.append(...children); }
  get isConnected() { return this.tag === 'root' || !!this.parent?.isConnected; }
  append(...items) { for (const item of items) { if (typeof item === 'string') this.children.push(item); else { item.parent = this; this.children.push(item); } }
    if (this.tag === 'select' && !this.value) this.value = this.children[0]?.props.value || ''; }
  appendChild(node) { this.append(node); }
  replaceChildren(...items) { for (const item of this.children) if (item instanceof Node) item.parent = null; this.children = []; this.content = ''; this.append(...items); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); this.parent = null; }
  addEventListener(kind, fn) { (this.listeners[kind] ||= []).push(fn); }
  fire(type = 'click') { return Promise.all((this.listeners[type] || []).map(fn => fn({ currentTarget: this }))); }
  focus() {}
  get textContent() { return this.content + this.children.map(c => typeof c === 'string' ? c : c.textContent).join(''); }
  set textContent(t) { this.replaceChildren(); this.content = t; }
  set innerHTML(_) { assert.fail('captured text must never be parsed'); }
}
const el = (tag, props = {}, ...kids) => new Node(tag, props, kids);
const all = (node, key) => [node, ...node.children.filter(c => c instanceof Node).flatMap(n => all(n))].filter(n => !key || n.props.data?.egMemory === key);
const find = (node, key) => all(node, key)[0];
async function fixture(custom = {}, initial = captures) {
  let rows = [], latest, current = true; const calls = [], root = el('root');
  const request = async (action, body) => {
    calls.push({ action, body }); if (custom[action]) return custom[action](body);
    if (action === 'state') return { captures: initial, rows, decisionMode: 'off' };
    if (action === 'preview') return { text: `<img>선택한 ${body.pin.startLine}줄` };
    if (action === 'bind') { latest = body; rows = [{ label: body.label, id: 'private-handle', automatic: true }]; return { id: rows[0].id }; }
    if (action === 'read') return { trace: { version: 1, ledger: { ...latest.ledger, text: '정확한 장부 행' }, sources: latest.sources.map(pin => ({ ...pin, text: '지정한 줄만\n둘째 줄' })) } };
    if (action === 'revoke') { rows = []; return { revoked: true }; }
    assert.fail(action);
  };
  const panel = view.mountEvidencePanel({ el, host: root, request, current: () => current, agentName: '하나', close: () => { current = false; panel.remove(); } });
  await wait(); return { panel, calls, f: key => find(panel, key) };
}

test('only a live established profiled DM gives flat routing hints, never a Board or unowned/fresh session', () => {
  assert.deepEqual(view.evidenceRoute(thread, codex), route);
  for (const change of [{ type: 'group' }, { conversationId: null }, { agentProfileId: null }, { profileEnabled: false }, { stateless: true }, { forkedFrom: { conversationId: 'base' } }, { bindingAccountKey: 'codex:oauth:else' }])
    assert.equal(view.evidenceRoute({ ...thread, ...change }, codex), null);
  for (const change of [{ connected: false }, { activeThreadId: 'other' }, { hudView: 'list' }, { authStatus: { isLoggedIn: false } }]) assert.equal(view.evidenceRoute(thread, { ...codex, ...change }), null);
});
test('only fixed local POST routes; ignore a reply after owner loss even if transport returns success', async () => {
  let live = true, count = 0; const response = deferred(), controller = new AbortController();
  const req = view.scopedEvidenceRequest({ route, signal: controller.signal, current: () => live, fetchJson: (url, init) => {
    count++; assert.equal(url, '/memory-evidence/preview'); assert.equal(init.method, 'POST'); assert.equal(init.signal, controller.signal);
    assert.deepEqual(JSON.parse(init.body), { ...route, pin: {} }); return response.promise; } });
  await assert.rejects(req('../chat')); const call = req('preview', { pin: {}, expectedProfileId: 'wrong' });
  live = false; response.resolve({ text: 'private' }); await assert.rejects(call); await assert.rejects(req('state')); assert.equal(count, 1);
});
test('register named row with typed lines and explicit consent; read exact pins and revoke without showing the handle', async () => {
  const { panel, calls, f } = await fixture(); assert.equal(f('consent').checked, false); assert.match(f('mode').textContent, /자동 첨부되지/);
  const ledger = f('ledger'), source = f('source');
  const select = async (box, key, val, event = 'change') => { const input = find(box, key); input.value = val; await input.fire(event); };
  await select(source, 'start-page', '2'); await select(source, 'start', '102'); await select(source, 'end', '103');
  await select(source, 'relation', 'posted'); await select(panel, 'label', '3월 장부', 'input'); await select(panel, 'terms', '3월, 전표, 3월', 'input');
  await find(ledger, 'preview').fire(); await find(source, 'preview').fire(); assert.equal(find(source, 'text').textContent, '<img>선택한 102줄');
  await f('bind').fire(); assert.equal(calls.some(c => c.action === 'bind'), false);
  f('consent').checked = true; await f('consent').fire('change'); assert.equal(f('bind').disabled, false);
  await select(source, 'relation', 'coverage'); assert.equal(f('consent').checked, false); f('consent').checked = true; await f('consent').fire('change');
  await f('bind').fire(); const body = calls.find(c => c.action === 'bind').body;
  assert.deepEqual(body, { consent: true, label: '3월 장부', terms: ['3월', '전표'], ledger: { sourceId: captures[0].sourceId, revision: captures[0].revision, startLine: 1, endLine: 1 },
    sources: [{ sourceId: captures[1].sourceId, revision: captures[1].revision, startLine: 102, endLine: 103, relation: 'coverage' }] });
  assert.equal(f('read').textContent, '3월 장부'); assert.equal(f('trace').textContent, ''); await f('read').fire();
  assert.ok(f('trace').textContent.includes('지정한 줄만\n둘째 줄')); assert.ok(f('trace').textContent.includes(captures[1].revision)); assert.doesNotMatch(panel.textContent, /private-handle/);
  await f('revoke').fire(); assert.equal(f('read'), undefined); assert.equal(f('trace').textContent, '');
});
test('1–6 sources; stale previews cannot survive line changes, removal or closing the panel', async () => {
  const d = deferred(); const { panel, f } = await fixture({ preview: () => d.promise }); for (let i = 0; i < 8; i++) await f('add-source').fire();
  assert.equal(all(panel, 'source').length, 6); assert.equal(f('add-source').disabled, true); const old = f('source');
  const pending = find(old, 'preview').fire(); await find(old, 'remove-source').fire(); const p2 = find(f('source'), 'preview').fire();
  const start = find(f('source'), 'start'); start.value = '3'; await start.fire('change'); d.resolve({ text: 'STALE' }); await Promise.all([pending, p2]);
  assert.doesNotMatch(panel.textContent, /STALE/); while (all(panel, 'source').length > 1) await f('remove-source').fire();
  await f('remove-source').fire(); assert.equal(all(panel, 'source').length, 1); await f('close').fire(); assert.equal(panel.isConnected, false);
});
test('empty state explains existing attachment workflow without loading files or performing other actions', async () => {
  const { panel, calls } = await fixture({}, []); assert.match(panel.textContent, /＋ 첨부 → 파일 선택/); assert.deepEqual(calls.map(c => c.action), ['state']);
});
test('real Firefox bridge closes on engine epoch, owner or room switch; no public messages or Board IO in the scope', async () => {
  const surface = fs.readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
  const methods = surface.slice(surface.indexOf('      canOpenMemoryEvidence('), surface.indexOf('      createActivityReadScope(threadId, onInvalidate)'));
  assert.match(methods, /watchMemoRead\(threadId, \{ ownerOnly: true \}\)/); assert.doesNotMatch(methods, /sendMessage|addMessage|boardNotice|localStorage/);
  for (const mutation of ['room', 'account', 'agent', 'close', 'epoch']) {
    const state = { codex: { ...codex, threads: [{ ...thread }] } }, listeners = new Set(), document = { documentElement: el('root') }, body = el('body'); document.documentElement.append(body);
    const epochScope = chat.createChatEpochScope(), d = deferred(); let signal, released = false;
    const bridge = Function('MemoryEvidence', 'ChatState', 'listeners', 'epochScope', 'document', 'el', 'state', 'getCodexThreadById', 'watchMemoRead', 'codexThreadAgentProfile', 'fetchJson',
      `let memoryEvidence; return {${methods}};`)(view, chat, listeners, epochScope, document, el, state, (c,id) => c.threads.find(t => t.id === id),
      () => ({ current: () => state.codex.threads[0].agentProfileId === thread.agentProfileId && state.codex.authStatus === auth, release: () => { released = true; } }),
      () => ({ name: '하나' }), (_path, init) => { signal = init.signal; return d.promise; });
    bridge.openMemoryEvidence(thread.id, body); const panel = find(document.documentElement, 'panel'); assert.ok(panel?.isConnected);
    if (mutation === 'room') state.codex.activeThreadId = 'another'; if (mutation === 'agent') state.codex.threads[0].agentProfileId = 'another';
    if (mutation === 'account') state.codex.authStatus = null; if (mutation === 'close') bridge.closeMemoryEvidence(body); if (mutation === 'epoch') epochScope.reset();
    for (const fn of listeners) fn(); assert.ok(signal.aborted && released); assert.equal(panel.isConnected, false); assert.equal(listeners.size, 0);
    d.resolve({ captures: [], rows: [{ id: 'private', label: 'STALE' }] }); await wait(); assert.doesNotMatch(panel.textContent, /STALE/);
  }
});

test('inspection of the last answer follows its exact active grant; it never guesses by number, label or list order', async () => {
  const rows = [{ id: 'one', label: '같은 이름' }, { id: 'two', label: '같은 이름' }];
  const base = { captures: [], rows, decisionMode: 'on' };
  for (const [id, enabled] of [['two', true], ['withdrawn', false], [null, false]]) {
    const { calls, f } = await fixture({ state: () => ({ ...base, recentId: id }), read: () => ({ trace: { version: 1, ledger: { ...captures[0], startLine: 1, endLine: 1, text:'고정 행' }, sources: [{...captures[1], startLine: 1, endLine: 1, relation:'counted', text:'직접 센 수량'}] } }) });
    assert.equal(Boolean(f('read-latest')), enabled);
    if (enabled) { await f('read-latest').fire(); assert.deepEqual(calls.at(-1), { action: 'read', body: { id: 'two' } }); }
  }
});
