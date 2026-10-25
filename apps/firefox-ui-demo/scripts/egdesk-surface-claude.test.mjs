import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileFunction } from 'node:vm';
import { readSurfaceSource } from './egdesk-surface-source.mjs';
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';
import * as InputContext from '../overlay/resources/EGDeskInputContext.sys.mjs';
import { CodexChatRuntime } from '../helper/codex-chat-runtime.mjs';
import { createCodexEngineAdapter } from '../helper/codex-engine-adapter.mjs';
import { createClaudeEngineAdapter } from '../helper/claude-engine-adapter.mjs';
import { openChatStore } from '../helper/egdesk-chat-store.mjs';
import { describeClaudeEngine, publicEngineRow } from '../helper/engine-registry.mjs';

// Execute the current production functions, including el() and the bridge
// handlers. Firefox bootstrap, browser/OS input and real engines never run.
const source = readSurfaceSource();
const clone = value => JSON.parse(JSON.stringify(value));
const NOW = 1800000000000;
const claudeRow = (patch = {}) => ({ ...publicEngineRow(describeClaudeEngine({ installed: true, version: '2.1.300',
  auth: { status: 'signedIn', method: 'claudeai', account: 'test@example.invalid' } }, { capabilities: ['stream', 'resume'] })), ...patch });
const fileInput = (id = 'file') => ({ id, kind: 'file', label: '선택한 파일', sourceRef: { kind: 'file', path: `/work/${id}.txt` } });
function functionSource(name, indent = '  ') {
  const match = source.match(new RegExp(`^${indent}(?:async )?function ${name}\\([^]*?^${indent}\\}`, 'm'));
  assert.ok(match, `production function ${name}`);
  return match[0];
}
function methodSource(name) {
  const match = source.match(new RegExp(`^      async ${name}\\([^]*?^      \\},`, 'm'));
  assert.ok(match, `production bridge method ${name}`);
  return match[0].slice(0, -1);
}
function between(start, end, from = 0) {
  const a = source.indexOf(start, from), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `production block ${start.trim()}`);
  return source.slice(a, b);
}
function compile(body, bindings) {
  return compileFunction(body, Object.keys(bindings), { filename: 'egdesk-surface-production.js' })(...Object.values(bindings));
}

class Node {
  constructor(tag, text = '') {
    this.tag = tag; this.text = text; this.children = []; this.attributes = {};
    this.dataset = {}; this.style = {}; this.events = {}; this.disabled = false;
    this.checked = false; this.value = ''; this.className = ''; this.scrollTop = 0; this.isConnected = true; this.scrollHeight = 40;
  }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'disabled') this.disabled = true; }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  appendChild(node) { node.parent = this; this.children.push(node); return node; }
  replaceChildren(...nodes) { this.children = []; nodes.forEach(node => this.appendChild(node)); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  querySelectorAll(selector) {
    const matches = node => selector.startsWith('.') ? node.className.split(' ').includes(selector.slice(1))
      : selector.startsWith('#') ? node.getAttribute('id') === selector.slice(1)
        : node.tag === selector;
    return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  get textContent() { return this.text + this.children.map(node => node.textContent).join(''); }
  fire(type, data = {}) { return Promise.all((this.events[type] || []).map(fn => fn({ target: this, preventDefault() {}, stopPropagation() {}, ...data }))); }
}
const all = node => [node, ...node.children.flatMap(all)];
const nodes = (node, testid) => all(node).filter(item => item.dataset.testid === testid);
const attributes = node => all(node).map(item => ({ attributes: item.attributes, data: item.dataset }));
const choose = async (node, checked = true) => { node.checked = checked; await node.fire('change'); };
const type = async (node, text) => { node.value = text; await node.fire('input'); };

function surface({ run = null, thread = {}, auth = {}, fetchJson = async () => ({ accepted: false }), ensureReady = async () => true, nativeReady = false } = {}) {
  const root = new Node('root');
  const document = { documentElement: root, activeElement: null, defaultView: { getComputedStyle: () => ({ maxHeight: '240' }) },
    createElement: tag => Object.assign(new Node(tag), { ownerDocument: document }),
    createTextNode: text => new Node('#text', text), getElementById: id => root.querySelector(`#${id}`),
    querySelectorAll: selector => root.querySelectorAll(selector) };
  const initial = { id: 'ui', clientThreadId: 'ui', engineId: 'claude', messages: [], inputSources: [], briefingInputs: [], ...thread };
  const protocol = ChatState.createChatProtocolState();
  if (run) protocol.runs[ChatState.runKey(run.conversationId, run.runId)] = run;
  const state = { panTarget: {}, agenda: {}, surface: {}, boards: {}, contextSuggest: { byThread: {} }, codex: {
    threads: [initial], activeThreadId: 'ui', activityThreadId: 'ui', chatProtocol: protocol,
    threadDrafts: { ui: '  keep my draft  ' }, threadDraftRevisions: { ui: 0 }, recentEngineId: 'codex',
    engines: [{ id: 'codex', status: 'ready' }, claudeRow()],
    authStatus: { isLoggedIn: true, accountId: 'test-account', ...auth }, connected: true, liveRevision: 0,
  } };
  const effects = { emits: 0, capture: [], requests: [], ready: 0, timers: 0, synced: [], logs: [] };
  const epochScope = ChatState.createChatEpochScope();
  const userInputDrafts = new Map();
  const globals = { ChatState, InputContext, document, state, protocol, userInputDrafts, epochScope,
    SELF_MEMBER: 'self', cloneJson: clone, formatMessageTime: String, contextBoardTitle: () => '',
    openChatFileReference: () => assert.fail('unexpected file open'), currentViewportAgendaLabel: () => '',
    serializeCardState: () => assert.fail('unexpected card'), serializeShapeState: () => assert.fail('unexpected shape'),
    emit: () => { effects.emits++; },
    updateThreadById: (id, updater) => { state.codex.threads = state.codex.threads.map(item => item.id === id ? updater(item) : item); },
    appendMessageToThread: (id, message) => { state.codex.threads.find(item => item.id === id).messages.push(message); },
    ensureNativeReadyForSend: async item => { effects.ready++; return ensureReady(item); },
    captureThreadInputs: async (item, inputs) => { effects.capture.push(clone(inputs)); return inputs.map(input => ({ snapshotId: `capture-${input.id}`, sourceId: input.id })); },
    browserToolSelectedSources: () => [], rootSseReady: () => ({ sourceReady: true }),
    codexThreadAgentProfile: () => null, codexThreadRuntimeConfig: () => ({}),
    syncProtocolRun: value => effects.synced.push(value), expireContextSuggestions: () => assert.fail('unexpected context expiry'),
    setTimeout: () => { effects.timers++; assert.fail('automatic timer'); }, setInterval: () => assert.fail('automatic timer'),
    console: Object.fromEntries(['log', 'warn', 'error', 'debug', 'info'].map(name => [name, (...values) => effects.logs.push(values)])),
    fetchJson: async (path, options) => { effects.requests.push({ path, body: options?.body ? JSON.parse(options.body) : null }); return fetchJson(path, options); },
    refreshing: new Map(), resumedNativeBindings: new Set(),
  };
  const definitions = ['el', 'getCodexThreadById', 'getActiveCodexThread', 'getCodexThreadDraft', 'createCodexMessage',
    'codexRuns', 'codexRunLabel', 'codexUserInputBlock', 'pruneUserInputDrafts', 'contextResolverRecordSection',
    'codexSubAgentSection', 'renderCodexActivityPanel', 'serializeDeskSnapshot'].map(name => functionSource(name)).join('\n');
  if (nativeReady) delete globals.ensureNativeReadyForSend;
  const api = compile(`${definitions}\n${functionSource('threadBusy', '    ')}\n${functionSource('refreshConversation', '    ')}
    ${nativeReady ? functionSource('ensureNativeReadyForSend', '    ') : ''}
    let activityPanelComposing = false, activityPanelDeferred = false;
    ${source.match(/^  const userInputDraftKey = .*;$/m)[0]}
    const bridge = { ${['replyApproval', 'replyUserInput', 'sendMessage'].map(methodSource).join(',\n')} };
    return { ...bridge, render: renderCodexActivityPanel, question: codexUserInputBlock, serialize: serializeDeskSnapshot,
      refresh: refreshConversation, el };`, globals);
  state.codexBridge = { ...api, refreshConversation: () => {} };
  return { ...api, state, protocol, effects, epochScope, drafts: userInputDrafts, document, root,
    thread: () => state.codex.threads[0], panel: () => document.getElementById('egd-codex-activity-panel') };
}

function composer(ui) {
  const block = between("            const input = el('textarea', {", "            input.addEventListener('input'");
  const controls = compile(`${functionSource('getCodexThreadDraft')}\n${block}\nreturn {input, sendButton, resizeComposer};`, {
    el: ui.el, ChatState, activeThread: ui.thread(), codex: ui.state.codex, codexBridge: ui,
    compositionInProgress: false,
  });
  controls.resizeComposer();
  return controls;
}
function emptyChat(ui) {
  const block = between('          const canStart = activeEngine.engineId', '        } else {\n          // Agent answers');
  const messages = ui.el('div');
  compile(block, { el: ui.el, ChatState, activeThread: ui.thread(), codex: ui.state.codex,
    activeEngine: ChatState.chatThreadReadiness(ui.thread(), ui.state.codex), messages,
    codexBridge: { startLogin: () => assert.fail('Claude opened Codex login'), refreshAuthStatus: () => {} },
    renderEngineChoices: () => ui.el('div'), renderStatelessStart: () => ui.el('div') });
  return messages;
}
function accountLifecycle(ui) {
  const effects = { reset: 0, resetScopes: [], reconnect: 0, cleared: 0, timers: [] };
  const definitions = between('    const resetThreadConversations = () => {', '    const fetchJson = async')
    + '\n' + between('    const update = (patch) => {', '    const findThreadIndexById');
  const api = compile(`let streamReady = true, source = null, activityPanelComposing = false, activityPanelDeferred = false;
    let browserToolAuthorityEpoch = 0, browserToolFixtureLastAction = null;
    ${definitions}
    const engineStatus = ChatState.createEngineStatusDebouncer({ current: () => state.codex.engines, apply: engines => update({engines}),
      setTimer: fn => { effects.timers.push(fn); return effects.timers.length; }, clearTimer() {} });
    ${between('    const handleEvent = (event) => {', '    const connect = async')}
    return {update, reset: resetThreadConversations, event: handleEvent};`, {
    ChatState, state: ui.state, protocol: ui.protocol, userInputDrafts: ui.drafts, document: ui.document, effects,
    epochScope: { ...ui.epochScope, reset: scope => { effects.reset++; effects.resetScopes.push(scope); ui.epochScope.reset(scope); } },
    clearBrowserToolTransport: () => effects.cleared++,
    resumedNativeBindings: new Set(), refreshing: new Map(), chatBindingNonce: () => 'new-codex-binding',
    normalizeThreads: () => {}, emit: () => {}, scheduleReconnect: () => effects.reconnect++,
    forgetContextSuggestions: () => assert.fail('Claude selections were cleared'),
  });
  return { ...api, effects };
}

test('real send button and empty-chat content use Claude readiness with Codex offline', async () => {
  const ui = surface({ auth: { isLoggedIn: false } });
  ui.state.codex.connected = false;
  ui.state.codex.engines[0].status = 'offline';
  const controls = composer(ui);
  assert.equal(controls.sendButton.disabled, false);
  assert.equal(controls.sendButton.title, '보내기');
  const empty = emptyChat(ui);
  assert.match(empty.textContent, /어떤 일을 함께할까요/);
  assert.doesNotMatch(empty.textContent, /Codex 연결|로그인 필요/);
  await controls.sendButton.fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ui.effects.requests.length, 1);
  assert.equal(ui.effects.requests[0].body.engineId, 'claude');
  assert.equal(Object.values(ui.protocol.requests)[0].accountKey, null);
});

test('real send controls and handler refuse every non-ready Claude row even with Codex signed in', async () => {
  for (const row of [null, ...['offline', 'starting', 'loginRequired', 'disabled', 'notInstalled', 'versionUnsupported', 'decisionPending'].map(status => claudeRow({status})),
    claudeRow({profiles: []}), claudeRow({profiles: [{active: true, auth: {status: 'unknown'}}]}),
    claudeRow({statusReason: 'CLAUDE_API_KEY_DETECTED'})]) {
    const ui = surface();
    ui.state.codex.engines = [{id: 'codex', status: 'ready'}, ...(row ? [row] : [])];
    const controls = composer(ui);
    assert.equal(controls.sendButton.disabled, true);
    await controls.sendButton.fire('click');
    await ui.sendMessage();
    assert.deepEqual(ui.effects.requests, []);
    assert.deepEqual(ui.effects.capture, []);
    assert.equal(ui.thread().engineId, 'claude');
    assert.equal(ui.state.codex.threadDrafts.ui, '  keep my draft  ');
  }
  const codex = surface({thread: {engineId: 'codex'}, auth: {isLoggedIn: false}});
  assert.equal(composer(codex).sendButton.disabled, true, 'Claude ready does not authorize Codex');
  await codex.sendMessage(); assert.deepEqual(codex.effects.requests, []);
  codex.state.codex.authStatus.isLoggedIn = true;
  assert.equal(composer(codex).sendButton.disabled, false);
  codex.state.codex.connected = false;
  assert.equal(composer(codex).sendButton.disabled, true);
});

test('Claude resume checks backend ownership without a Codex hash, and refusal prevents send', async () => {
  for (const refused of [false, true]) {
    const ui = surface({ nativeReady: true, auth: {isLoggedIn: false},
      thread: {conversationId: 'claude-cid', bindingState: 'live-unverified', bindingAccountKey: 'codex::old'},
      fetchJson: async path => {
        if (path === '/chat/resume') {
          if (refused) throw Object.assign(new Error('wrong Claude account'), {code: 'ACCOUNT_CHANGED', status: 409});
          return {conversationId: 'claude-cid', runs: [], historyComplete: true};
        }
        return {accepted: false};
      } });
    ui.state.codex.connected = false;
    await ui.sendMessage();
    assert.deepEqual(ui.effects.requests.map(row => row.path), refused ? ['/chat/resume'] : ['/chat/resume', '/chat/send']);
    assert.deepEqual(ui.effects.requests[0].body, {conversationId: 'claude-cid', clientThreadId: 'ui', engineId: 'claude'});
    if (refused) { assert.equal(ui.effects.capture.length, 0); assert.deepEqual(ui.thread().messages, []); }
  }
});

test('Claude Desk restore and local history preserve engine and routing, never promote a Codex key', () => {
  const saved = {id: 'ui', engineId: 'claude', conversationId: 'claude-cid', clientBindingId: 'ui-binding-original',
    bindingAccountKey: 'codex::old', messages: []};
  const detached = ChatState.detachNativeThread(saved, 'codex::another', 'ignored');
  const restored = ChatState.reconcileNativeThread(detached, {isLoggedIn: false});
  assert.equal(restored.conversationId, 'claude-cid');
  assert.equal(ChatState.clientThreadBinding(restored), 'ui-binding-original');
  assert.equal(restored.bindingAccountKey, null);
  assert.equal(restored.bindingState, 'server-check-required');
  assert.equal(ChatState.nativeBindingHeld(restored), false);
  assert.equal(ChatState.canResumeNativeThread(restored, null, {engines: [claudeRow()]}), true);
  assert.equal(ChatState.canResumeNativeThread(restored, null, {engines: [claudeRow({status:'offline'})]}), false);
  const hydrated = ChatState.hydrateLocalChatThread(restored, {clientThreadId:'ui', messages: [], runs: [], threadSnapshot: {engineId:'claude'}});
  assert.equal(hydrated.engineId, 'claude');
  assert.equal(hydrated.bindingAccountKey, null);
  assert.equal(ChatState.nativeBindingForRun(restored, {conversationId:'claude-cid', accountKey:'codex::wrong'}).bindingAccountKey, null);
});

test('Codex account switches preserve Claude requests, runs, drafts and binding; real disconnect disables it', () => {
  const ui = surface({thread: {conversationId: 'claude-cid', bindingState: 'server-check-required'}});
  ui.state.codex.codexAccountKey = 'codex::old';
  ui.state.codex.threads.push({id:'codex-room', engineId:'codex', conversationId:'codex-cid', bindingAccountKey:'codex::old', messages:[]});
  ui.protocol.requests.claude = {engineId:'claude', clientThreadId:'ui', status:'submitting'};
  ui.protocol.requests.codex = {clientThreadId:'codex-room', status:'submitting'};
  ui.protocol.runs.claude = {engineId:'claude', conversationId:'claude-cid', clientThreadId:'ui', status:'running'};
  ui.protocol.runs.codex = {engineId:'codex', conversationId:'codex-cid', clientThreadId:'codex-room', status:'running'};
  ui.drafts.set('claude-cid/r/q', [{optionIndices:[0,1]}]);
  ui.drafts.set('codex-cid/r/q', [{choice:0}]);
  ui.state.contextSuggest.byThread.ui = {picked:['keep']};
  const before = clone({thread:ui.thread(), request:ui.protocol.requests.claude, run:ui.protocol.runs.claude});
  const lifecycle = accountLifecycle(ui);
  lifecycle.update({authStatus:{isLoggedIn:true, accountId:'new'}});
  assert.deepEqual(ui.thread(), before.thread);
  assert.deepEqual(ui.protocol.requests.claude, before.request);
  assert.deepEqual(ui.protocol.runs.claude, before.run);
  assert.equal(ui.protocol.requests.codex, undefined); assert.equal(ui.protocol.runs.codex, undefined);
  assert.equal(ui.drafts.has('claude-cid/r/q'), true); assert.equal(ui.drafts.has('codex-cid/r/q'), false);
  assert.deepEqual(ui.state.contextSuggest.byThread.ui.picked, ['keep']);
  assert.deepEqual(lifecycle.effects.resetScopes, ['codex'], 'only Codex requests were invalidated');
  assert.equal(ChatState.chatThreadReadiness(ui.thread(), ui.state.codex).ready, true);
  lifecycle.update({connected:false});
  assert.equal(ChatState.chatThreadReadiness(ui.thread(), ui.state.codex).ready, false);
  assert.equal(composer(ui).sendButton.disabled, true);
});

test('Claude engine.status downgrades immediately even while Codex login status is debounced', () => {
  const ui = surface(), lifecycle = accountLifecycle(ui);
  lifecycle.event({type:'engine.status', engines:[{id:'codex',status:'loginRequired'}, claudeRow({status:'offline'})]});
  assert.equal(ChatState.chatThreadReadiness(ui.thread(), ui.state.codex).ready, false);
  assert.equal(composer(ui).sendButton.disabled, true);
});

test('Claude does not schedule, request or display Codex Context suggestions', async () => {
  const ui = surface();
  const definitions = ['requestContextSuggestions', 'resolveContextSuggestions'].map(name => functionSource(name, '    ')).join('\n');
  const api = compile(`${functionSource('getCodexThreadById')}\n${functionSource('buildContextSuggestions')}\n${definitions}
    return {request:requestContextSuggestions, resolve:resolveContextSuggestions, render:buildContextSuggestions};`, {
    state:ui.state, ChatState, window:{setTimeout:()=>assert.fail('Claude scheduled Codex Context'), clearTimeout:()=>{}},
    fetchJson:()=>assert.fail('Claude queried Codex Context') });
  ui.state.contextSuggest.byThread.ui = {picked:['selected'], resolution:{resolutionId:'unchanged'}};
  api.request('ui'); await api.resolve('ui', true);
  assert.equal(api.render(ui.thread(), {}), null);
  assert.deepEqual(ui.state.contextSuggest.byThread.ui.picked, ['selected']);
});

test('real delayed Codex captures abort on account switch while an actual Claude send remains valid', async () => {
  for (const kind of ['browser', 'managed-file']) {
    let finishClaude, finishCapture;
    const ui = surface({auth: {accountId:'account-a'}, fetchJson: (_path, options) => new Promise(resolve => {
      finishClaude = () => resolve({accepted:true, requestId:JSON.parse(options.body).requestId,
        conversationId:'claude-kept', runId:'claude-run', engineId:'claude'});
    })});
    ui.state.codex.codexAccountKey = ChatState.codexAccountKey(ui.state.codex.authStatus);
    const oldCodex = {id:'codex-a', engineId:'codex', conversationId:'cid-a', messages:[], bindingAccountKey:ui.state.codex.codexAccountKey};
    ui.state.codex.threads.push(oldCodex);
    const claudeSend = ui.sendMessage();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof finishClaude, 'function', 'production Claude send reached its pending HTTP request');
    const claudeToken = [...Object.values(ui.protocol.requests)][0];
    assert.equal(claudeToken.engineId, 'claude');
    const oldToken = ui.epochScope.begin();
    const posts = [];
    const capture = compile(`${functionSource('captureThreadInputs', '    ')}\nreturn captureThreadInputs;`, {
      ChatState, InputContext, epochScope:ui.epochScope,
      captureChatInputs: () => new Promise(resolve => { finishCapture = () => resolve([{text:'ACCOUNT_A_CAPTURE'}]); }),
      captureManagedFileInput: () => new Promise(resolve => { finishCapture = () => resolve({text:'ACCOUNT_A_CAPTURE'}); }),
      fetchJson: async (path, options) => { posts.push({path, account:ui.state.codex.authStatus.accountId, body:options.body}); return {captures:[]}; },
    });
    const input = kind === 'browser' ? {id:'a-browser',kind:'browser',sourceRef:{viewId:'a-view'}}
      : {...fileInput('a-file'),sourceRef:{path:'/work/a-file.txt',draftId:'a-draft'}};
    const capturing = capture(oldCodex, [input], oldToken);
    const rejected = assert.rejects(capturing, /연결이 바뀌어 자료 캡처를 중단/);
    assert.equal(typeof finishCapture, 'function');
    const lifecycle = accountLifecycle(ui);
    lifecycle.update({authStatus:{isLoggedIn:true,accountId:'account-b'}});
    assert.equal(oldToken.signal.aborted, true);
    assert.equal(ui.epochScope.valid(oldToken), false);
    finishCapture();
    await rejected;
    assert.deepEqual(posts, [], 'no account-A capture may POST under account B');
    finishClaude();
    await claudeSend;
    assert.equal(claudeToken.status, 'accepted', 'the real Claude send token still accepted its HTTP result');
    assert.equal(ui.effects.synced[0].engineId, 'claude');
    assert.equal(ui.epochScope.valid(ui.epochScope.begin()), true, 'new Codex work uses the new generation');
  }
});

test('scoped epoch reset aborts active work and invalidates finished Codex tokens without cancelling Claude', () => {
  const scope = ChatState.createChatEpochScope();
  const a = scope.begin(), finished = scope.begin(), claude = scope.begin('claude');
  scope.finish(finished);
  const stream = scope.current();
  scope.reset('codex');
  assert.equal(a.signal.aborted, true); assert.equal(scope.valid(a), false);
  assert.equal(scope.valid(finished), false, 'a settled but delayed callback cannot regain account authority');
  assert.equal(claude.signal.aborted, false); assert.equal(scope.valid(claude), true);
  assert.equal(scope.valid(stream), true, 'engine reset is not a shared transport reset');
  scope.reset();
  assert.equal(claude.signal.aborted, true); assert.equal(scope.valid(claude), false);
  assert.equal(scope.valid(stream), false);
});

test('production engine popover reanchors to its fresh local chip across Canvas pan/zoom and HUD', () => {
  const window = {innerWidth:1440, innerHeight:900};
  const geometry = compile(`${functionSource('resolveFloatingMenuPlacement')}\n${functionSource('positionChatEngineMenu')}
    return {place:resolveFloatingMenuPlacement, position:positionChatEngineMenu};`, {window});
  const toggleSource = source.match(/^      toggleEngineMenu\([^]*?^      \},/m)?.[0];
  assert.ok(toggleSource);
  const renderSource = between('      const engineContext = {', '      // CHAT-07: the profile peek');
  const attachmentSource = between("      body.appendChild(el('div', { class: shellClasses }, ...contentChildren));", '      const msgEl = body.querySelector');
  for (const scene of [
    {name:'translated Canvas at 96%', x:-620, y:80, scale:.96, anchor:{left:845,right:913,top:202,bottom:226}},
    {name:'panned/zoomed-out Canvas',x:-320,y:120,scale:.5,anchor:{left:645,right:713,top:302,bottom:326}},
    {name:'zoomed-in Canvas',x:150,y:-90,scale:1.6,anchor:{left:745,right:813,top:202,bottom:226}},
    {name:'HUD',x:0,y:0,scale:1,anchor:{left:1240,right:1320,top:150,bottom:174}},
    {name:'translated HUD containing block',x:970,y:80,scale:1,anchor:{left:1240,right:1320,top:150,bottom:174}},
    {name:'left/bottom viewport edge',x:-150,y:-500,scale:.8,anchor:{left:10,right:60,top:840,bottom:864}},
  ]) {
    const ui = surface(), clicked = {isConnected:true,getBoundingClientRect:()=>scene.anchor};
    const bridge = compile(`return {${toggleSource.slice(0,-1)}};`, {state:ui.state, emit:()=>{clicked.isConnected=false;},resolveFloatingMenuPlacement:geometry.place});
    bridge.toggleEngineMenu('ui', clicked);
    const renderers = compile(`${renderSource}\nreturn {chip:renderEngineChip,panel:renderEnginePanel};`, {
      ChatState, codex:ui.state.codex, codexBridge:bridge, el:ui.el, deskIcon:()=>ui.el('span'),
    });
    const menu = renderers.panel(ui.thread()), freshChip = renderers.chip(ui.thread());
    const anchorRect = {...scene.anchor};
    freshChip.getBoundingClientRect = () => anchorRect;
    menu.offsetWidth = 286; menu.offsetHeight = 230;
    menu.getBoundingClientRect = () => {
      const left = scene.x + parseFloat(menu.style.left) * scene.scale;
      const top = scene.y + parseFloat(menu.style.top) * scene.scale;
      return {left,top,width:menu.offsetWidth*scene.scale,height:menu.offsetHeight*scene.scale,
        right:left+menu.offsetWidth*scene.scale,bottom:top+menu.offsetHeight*scene.scale};
    };
    const body = ui.el('div'), before = clone(ui.state.codex.engineMenu);
    const attach = () => compile(attachmentSource, {body,el:ui.el,shellClasses:'egd-codex-chat-shell',
      contentChildren:[freshChip,menu],positionChatEngineMenu:geometry.position});
    if (scene.name === 'translated Canvas at 96%') assert.ok(menu.getBoundingClientRect().left < 10, 'reproduce detached left-edge position before correction');
    attach();
    const check = () => {
      const actual = menu.getBoundingClientRect();
      const expected = geometry.place(anchorRect,actual.width,actual.height);
      assert.ok(Math.abs(actual.left-expected.left)<.01,`${scene.name}: x follows own chip`);
      assert.ok(Math.abs(actual.top-expected.top)<.01,`${scene.name}: y follows own chip`);
      assert.ok(actual.left>=8 && actual.right<=1432 && actual.top>=8 && actual.bottom<=892,`${scene.name}: on screen`);
    };
    check();
    anchorRect.left+=15; anchorRect.right+=15;
    body.replaceChildren(); attach(); check();
    assert.deepEqual(ui.state.codex.engineMenu,before,'positioning never mutates the Canvas or menu state');
    assert.equal(geometry.position(menu,{...freshChip,isConnected:false}),false,'detached click target is never reused');
  }
});

// Real adapter, runtime and SQLite public projections, with only the native
// stdio transport replaced. No provider, credential, CLI or OS calls.
async function runtime(t, { store = false } = {}) {
  let chatStore = null;
  if (store) {
    const dir = mkdtempSync(join(tmpdir(), 'egdesk-surface-claude-'));
    chatStore = openChatStore({ dataDir: dir, ownerScope: 'surface-test' });
    t.after(() => { chatStore.close(); rmSync(dir, { recursive: true, force: true }); });
  }
  const events = [], transports = [], timers = [], codexCalls = [];
  const claude = createClaudeEngineAdapter({
    snapshot: () => ({ installed: true, version: '2.1.300', versionStatus: 'untested',
      auth: { status: 'signedIn', method: 'claudeai', account: 'test@example.invalid' } }),
    env: {}, defaultCwd: '/work/test', resolveExecutable: () => '/fake/claude',
    setTimer: (fn, ms) => { const value = { fn, ms }; timers.push(value); return value; }, clearTimer() {},
    createTransport: options => {
      const transport = { options, sent: [], replies: [], delivered: true,
        async start() {}, sendUserMessage(value) { this.sent.push(clone(value)); },
        respondControl(id, answer) { this.replies.push({ id, ...clone(answer) }); return this.delivered; },
        info: () => ({ init: { billsApiKey: false } }), async interrupt() {}, async close() {},
      };
      transports.push(transport); return transport;
    },
  });
  const codex = createCodexEngineAdapter({ request: async (...args) => { codexCalls.push(args); assert.fail('Codex fallback'); },
    respond: () => assert.fail('Claude response routed to Codex') });
  const chat = new CodexChatRuntime({ engines: [codex, claude], store: chatStore, requireStore: !!chatStore,
    now: () => NOW, emit: event => events.push(event), verifyFile: async () => null,
    setTimer: () => assert.fail('runtime retry timer'), clearTimer() {} });
  const unsubscribe = claude.subscribe({ notification: (_, message) => chat.handleNotification(message),
    serverRequest: (_, message) => chat.handleServerRequest(message),
    connection: (id, connection) => chat.setConnection(id, connection.ready, connection) });
  claude.syncStatus();
  const drain = async () => { await chat.queue; await new Promise(resolve => setImmediate(resolve)); await chat.queue; };
  t.after(async () => { unsubscribe(); await claude.dispose(); await drain(); });
  const result = await chat.send({ message: 'test', engineId: 'claude', clientThreadId: 'ui', requestId: 'request-1' });
  const run = chat.runs.get(`${result.conversationId}/${result.runId}`);
  return { chat, result, run, events, transports, timers, codexCalls, drain,
    question: async (questions, id = 'question') => {
      transports[0].options.controlHandlers.can_use_tool({ subtype: 'can_use_tool', tool_name: 'AskUserQuestion',
        tool_use_id: id, input: { questions } }, { requestId: id });
      await drain();
      return run.pendingUserInputs.at(-1);
    },
    approval: async (overrides = {}) => {
      const transport = transports[0];
      transport.options.controlHandlers.can_use_tool({ subtype: 'can_use_tool', tool_name: 'Bash',
        tool_use_id: 'tool-1', input: { command: 'ls' }, permission_suggestions: [
          { type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'ls' }], destination: 'session' },
        ], ...overrides }, { requestId: 'approval' });
      await drain(); return run.pendingApprovals.at(-1);
    },
  };
}
const question = (extra = {}) => ({ id: 'q0', header: '고르기', question: '무엇을 쓸까요?', multiSelect: true,
  options: [{ label: 'A, B' }, { label: 'C' }, { label: 'D' }], ...extra });
function uiRun(h) {
  const state = ChatState.createChatProtocolState();
  for (const event of h.events) ChatState.reduceChatEvent(state, event, ['codex', 'claude']);
  return state.runs[ChatState.runKey(h.result.conversationId, h.result.runId)];
}
function localRuns(h) {
  return ChatState.normalizeLocalHistoryPage(h.chat.getLocalHistory({ clientThreadId: 'ui', limit: 500 }), 'ui').runs;
}

test('required ChatState exports are present (never substitute copied implementations)', () => {
  for (const name of ['runRateLimitNotice', 'claudeContextSendErrorText']) assert.equal(typeof ChatState[name], 'function', `${name}: state worker integration pending`);
});

test('offered session approval uses the real request builder; unknown and forged decisions are refused', async t => {
  const h = await runtime(t);
  const offered = await h.approval();
  const run = uiRun(h), approval = run.pendingApprovals[0];
  assert.ok(offered.choices.includes('acceptForSession'));
  const calls = [];
  const ui = surface({ run });
  ui.state.codexBridge.replyApproval = request => calls.push(request);
  ui.render();
  let buttons = nodes(ui.panel(), 'chat-approval-choice');
  assert.deepEqual(buttons.map(button => button.textContent), ['이번만 허용', '이번 연결 세션에서 허용', '거절', '취소']);
  assert.match(buttons[1].getAttribute('title'), /연결이 다시 시작되면 재승인/);
  assert.doesNotMatch(buttons[1].textContent, /대화 동안/);
  await buttons[1].fire('click');
  assert.deepEqual(calls, [ChatState.approvalRequestFor(run, approval.approvalId, 'acceptForSession')]);
  approval.choices = ['accept', 'decline', 'cancel', 'invented', '__proto__', 'toString', 'constructor'];
  ui.render();
  buttons = nodes(ui.panel(), 'chat-approval-choice');
  assert.deepEqual(buttons.map(button => button.textContent), ['허용', '거절', '취소']);
  for (const decision of ['acceptForSession', 'invented', '__proto__', 'toString', 'constructor']) {
    assert.equal(ChatState.approvalRequestFor(run, approval.approvalId, decision), null);
    assert.equal(await ui.replyApproval({ ...run, approvalId: approval.approvalId, decision }), false);
  }
  assert.equal(ui.effects.requests.length, 0);
  assert.equal(calls.length, 1);
  for (const choices of [null, {}, 'acceptForSession', []]) {
    approval.choices = choices;
    ui.render();
    assert.deepEqual(nodes(ui.panel(), 'chat-approval-choice'), []);
  }
});

test('broker offers no session button without an actual session rule and refuses forged session decisions', async t => {
  for (const permission_suggestions of [undefined, [], [{ type: 'unsupported' }],
    [{ type: 'setMode', mode: 'acceptEdits' }], [{ type: 'addDirectories', directories: ['/work'] }],
    [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Write' }] }]]) {
    const h = await runtime(t);
    const approval = await h.approval({ permission_suggestions });
    assert.equal(approval.choices.includes('acceptForSession'), false);
    const run = uiRun(h), ui = surface({ run });
    ui.render();
    assert.deepEqual(nodes(ui.panel(), 'chat-approval-choice').map(button => button.dataset.decision), approval.choices);
    assert.equal(ChatState.approvalRequestFor(run, approval.approvalId, 'acceptForSession'), null);
    await assert.rejects(h.chat.replyApproval({ ...h.result, approvalId: approval.approvalId, decision: 'acceptForSession' }), { code: 'INVALID_DECISION' });
    assert.equal(h.transports[0].replies.length, 0);
  }
});

test('approval disabled state and click guard share pending, stale, history and scope rules', async t => {
  const h = await runtime(t); await h.approval();
  const run = uiRun(h), approval = run.pendingApprovals[0];
  const ui = surface({ run }); const calls = [];
  ui.state.codexBridge.replyApproval = request => calls.push(request);
  for (const [target, key, value] of [[approval, 'replyPending', true], [approval, 'stale', true],
    [approval, 'status', 'replySent'], [run, 'localHistory', true]]) {
    const before = target[key]; target[key] = value;
    ui.render();
    for (const button of nodes(ui.panel(), 'chat-approval-choice')) {
      assert.equal(button.disabled, true, `${key}: disabled`); await button.fire('click');
    }
    target[key] = before;
  }
  for (const extra of [{ acceptDisabledReason: '범위 미확인' }, { networkApprovalContext: { protocol: 'https' } }, { kind: 'unknown' }]) {
    const saved = { ...approval }; Object.assign(approval, extra); ui.render();
    for (const button of nodes(ui.panel(), 'chat-approval-choice').filter(button => button.dataset.decision.startsWith('accept'))) {
      assert.equal(button.disabled, true); await button.fire('click');
    }
    for (const key of Object.keys(extra)) { if (Object.hasOwn(saved, key)) approval[key] = saved[key]; else delete approval[key]; }
  }
  ui.render();
  const liveButton = nodes(ui.panel(), 'chat-approval-choice')[1];
  approval.stale = true;
  await liveButton.fire('click');
  assert.deepEqual(calls, [], 'a detached button cannot answer after the request becomes stale');
});

test('approval false or mismatched delivery is never shown accepted; true delivery keeps the run running', async t => {
  const h = await runtime(t); await h.approval();
  const run = uiRun(h), approval = run.pendingApprovals[0];
  const identity = { conversationId: run.conversationId, runId: run.runId, approvalId: approval.approvalId };
  let response = { ...identity, status: 'replySent', accepted: false };
  const ui = surface({ run, fetchJson: async () => response });
  for (const patch of [{ accepted: false }, { accepted: true, approvalId: 'another' }, { accepted: true, conversationId: 'another' }]) {
    response = { ...identity, status: 'replySent', ...patch };
    assert.equal(await ui.replyApproval({ ...identity, decision: 'acceptForSession' }), false);
    assert.equal(approval.status, 'pending');
    assert.equal(approval.replyPending, false);
    assert.match(approval.error, /확인하지 못했습니다/);
    ui.render(); assert.doesNotMatch(ui.panel().textContent, /응답 전달됨/);
  }
  response = { ...identity, status: 'replySent', accepted: true };
  await ui.replyApproval({ ...identity, decision: 'accept' });
  assert.equal(approval.status, 'replySent');
  assert.equal(ChatState.isRunBusy(run), true);
});

test('backend ask ceiling offers only one-off approval and rejects a forged session decision', async t => {
  const h = await runtime(t);
  h.run.toolCeiling = { terminal: 'ask' };
  const approval = await h.approval();
  assert.ok(approval.choices.includes('accept'));
  assert.equal(approval.choices.includes('acceptForSession'), false);
  const run = uiRun(h), ui = surface({ run }); ui.render();
  assert.deepEqual(nodes(ui.panel(), 'chat-approval-choice').map(button => button.textContent), ['허용', '거절', '취소']);
  await assert.rejects(h.chat.replyApproval({ ...h.result, approvalId: approval.approvalId, decision: 'acceptForSession' }), { code: 'INVALID_DECISION' });
  assert.equal(h.transports[0].replies.length, 0);
  const response = await h.chat.replyApproval(ChatState.approvalRequestFor(run, approval.approvalId, 'accept'));
  assert.equal(response.accepted, true);
  assert.equal(h.transports[0].replies[0].write.response.response.behavior, 'allow');
});

test('real transport false delivery reaches the UI as unconfirmed permission, never accepted', async t => {
  const h = await runtime(t); const approval = await h.approval();
  h.transports[0].delivered = false;
  const run = uiRun(h);
  const ui = surface({ run, fetchJson: async (_path, options) => h.chat.replyApproval(JSON.parse(options.body)) });
  assert.equal(await ui.replyApproval(ChatState.approvalRequestFor(run, approval.approvalId, 'acceptForSession')), false);
  assert.equal(run.pendingApprovals[0].status, 'pending');
  assert.equal(h.run.pendingApprovals[0].status, 'pending');
  ui.render(); assert.doesNotMatch(ui.panel().textContent, /응답 전달됨/);
});

test('multiSelect survives actual runtime SSE, snapshot and SQLite public history', async t => {
  const h = await runtime(t, { store: true });
  await h.question([question(), question({ id: 'q1', multiSelect: false, question: '하나만?' })]);
  const live = uiRun(h);
  const snapshotState = ChatState.createChatProtocolState();
  const snapshot = ChatState.mergeChatSnapshot(snapshotState, h.chat.snapshot(h.result.conversationId), 'ui')[0];
  const stored = localRuns(h).find(run => run.runId === h.result.runId);
  for (const run of [live, snapshot, stored]) {
    assert.equal(run.pendingUserInputs[0].questions[0].multiSelect, true);
    assert.notEqual(run.pendingUserInputs[0].questions[1].multiSelect, true);
  }
  assert.equal(stored.localHistory, true);
  assert.equal(ChatState.userInputRequestFor(stored, stored.pendingUserInputs[0].userInputId, null, 'skip'), null);
});

test('checkbox drafts are copied, survive real panel rerenders and send only optionIndices', async t => {
  const h = await runtime(t); await h.question([question()]);
  const run = uiRun(h), input = run.pendingUserInputs[0];
  const ui = surface({ run }); ui.render();
  let choices = nodes(ui.panel(), 'chat-user-input-option');
  assert.ok(choices.every(control => control.getAttribute('type') === 'checkbox'));
  await choose(choices[0]); await choose(choices[2]);
  const key = `${run.conversationId}/${run.runId}/${input.userInputId}`;
  const oldDraft = ui.drafts.get(key);
  assert.deepEqual(oldDraft[0].optionIndices, [0, 2]);
  ui.render();
  choices = nodes(ui.panel(), 'chat-user-input-option');
  assert.deepEqual(choices.map(control => control.checked), [true, false, true, false]);
  await choose(choices[1]);
  assert.deepEqual(oldDraft[0].optionIndices, [0, 2], 'rerender did not share the stored selection array');
  const draft = ui.drafts.get(key);
  const request = ChatState.userInputRequestFor(run, input.userInputId, draft);
  assert.deepEqual(request.answers, [{ questionId: 'q0', optionIndices: [0, 2, 1] }]);
  assert.equal(Object.hasOwn(request.answers[0], 'optionIndex'), false);
  request.answers[0].optionIndices.push(99);
  assert.deepEqual(draft[0].optionIndices, [0, 2, 1], 'request payload does not alias the UI draft');
  const sent = [];
  ui.state.codexBridge.replyUserInput = value => sent.push(ChatState.userInputRequestFor(run, input.userInputId, value.draft));
  await nodes(ui.panel(), 'chat-user-input-submit')[0].fire('click');
  assert.equal(sent.length, 1);
  assert.equal(Object.hasOwn(sent[0].answers[0], 'optionIndex'), false);
  await h.chat.replyUserInput(sent[0]);
  assert.deepEqual(h.transports[0].replies.at(-1).write.response.response.updatedInput.answers,
    { '무엇을 쓸까요?': '"A, B", D, C' });
});

test('Other is exclusive, secret values never enter attributes, transcript, Desk or SQLite history', async t => {
  const h = await runtime(t, { store: true }); await h.question([question()]);
  const run = uiRun(h), input = run.pendingUserInputs[0];
  input.questions[0].isSecret = true;
  const ui = surface({ run }); ui.render();
  const choices = nodes(ui.panel(), 'chat-user-input-option');
  await choose(choices[0]); await choose(choices.at(-1));
  assert.deepEqual(choices.map(control => control.checked), [false, false, false, true]);
  const field = nodes(ui.panel(), 'chat-user-input-other')[0];
  assert.equal(field.getAttribute('type'), 'password');
  await type(field, 'PRIVATE_TYPED_ANSWER');
  const key = `${run.conversationId}/${run.runId}/${input.userInputId}`;
  let draft = ui.drafts.get(key);
  assert.deepEqual(draft[0].optionIndices, []);
  assert.deepEqual(ChatState.userInputRequestFor(run, input.userInputId, draft).answers,
    [{ questionId: 'q0', text: 'PRIVATE_TYPED_ANSWER' }]);
  await choose(choices[1]);
  assert.equal(field.disabled, true); assert.equal(choices.at(-1).checked, false);
  assert.deepEqual(ChatState.userInputRequestFor(run, input.userInputId, ui.drafts.get(key)).answers,
    [{ questionId: 'q0', optionIndices: [1] }]);
  await choose(choices.at(-1));
  assert.equal(field.value, '', 'a listed choice clears the mutually exclusive Other answer');
  await type(field, 'PRIVATE_TYPED_ANSWER'); ui.render();
  assert.equal(nodes(ui.panel(), 'chat-user-input-other')[0].value, 'PRIVATE_TYPED_ANSWER');
  assert.equal(JSON.stringify([attributes(ui.panel()), ui.state, ui.serialize(), ui.effects.logs]).includes('PRIVATE_TYPED_ANSWER'), false);
  draft = ui.drafts.get(key);
  await h.chat.replyUserInput(ChatState.userInputRequestFor(run, input.userInputId, draft));
  assert.equal(JSON.stringify([h.events, h.chat.snapshot(), h.chat.getLocalHistory({ clientThreadId: 'ui', limit: 500 })]).includes('PRIVATE_TYPED_ANSWER'), false);
});

test('multiSelect invalid payloads, stale handlers, busy, sent, secret and historical cards are guarded', async t => {
  const h = await runtime(t); await h.question([question()]);
  const run = uiRun(h), input = run.pendingUserInputs[0];
  for (const optionIndices of [[], [0, 0], [-1], [3], ['0'], [0.5]]) {
    assert.equal(ChatState.userInputRequestFor(run, input.userInputId, [{ questionId: 'q0', choice: null, text: '', optionIndices }]), null);
  }
  assert.equal(ChatState.userInputRequestFor(run, input.userInputId, [{ questionId: 'q0', choice: 0, text: '' }]), null);
  assert.equal(ChatState.userInputRequestFor(run, input.userInputId, [{ questionId: 'q0', choice: 'other', text: 'private', optionIndices: [0] }]), null);
  const ui = surface({ run }); ui.render();
  await choose(nodes(ui.panel(), 'chat-user-input-option')[0]);
  const submit = nodes(ui.panel(), 'chat-user-input-submit')[0];
  const oldChoice = nodes(ui.panel(), 'chat-user-input-option')[1];
  const before = clone([...ui.drafts]);
  input.stale = true; await choose(oldChoice); await submit.fire('click');
  assert.deepEqual([...ui.drafts], before); assert.equal(ui.effects.requests.length, 0);
  delete input.stale;
  for (const [target, key, value] of [[input, 'replyPending', true], [input, 'stale', true], [input, 'status', 'replySent'],
    [run, 'status', 'completed'], [run, 'localHistory', true]]) {
    const old = target[key]; target[key] = value;
    const block = ui.question(run, input, before[0][1], { draft: () => assert.fail('locked draft'), submit: () => assert.fail('locked submit'), skip: () => assert.fail('locked skip') });
    for (const control of all(block).filter(node => ['input', 'button'].includes(node.tag))) {
      assert.equal(control.disabled, true); await control.fire('click');
      if (control.tag === 'input') { await choose(control); await type(control, 'must-not-edit'); }
    }
    target[key] = old;
  }
  input.status = 'replySent'; input.questions[0].isSecret = true;
  const secret = ui.question(run, input, before[0][1], {});
  assert.match(secret.textContent, /비공개 답변 전달됨/);
  assert.equal(all(secret).filter(node => node.tag === 'input').length, 0);
});

test('single-select Codex path retains radios, singular optionIndex, free text and one-off label', () => {
  const input = { userInputId: 'one', status: 'pending', questions: [{ questionId: 'q', header: 'Pick', question: 'One?',
    options: [{ label: 'yes' }, { label: 'no' }], allowsOther: true }] };
  const run = { conversationId: 'c', runId: 'r', clientThreadId: 'ui', status: 'inProgress', pendingUserInputs: [input],
    pendingApprovals: [{ approvalId: 'p', kind: 'commandExecution', status: 'pending', choices: ['accept', 'decline', 'cancel'] }] };
  const ui = surface({ run, thread: { engineId: 'codex' } });
  let draft;
  const block = ui.question(run, input, null, { draft: value => { draft = value; } });
  const choices = nodes(block, 'chat-user-input-option');
  assert.ok(choices.every(control => control.getAttribute('type') === 'radio'));
  choices[0].checked = true; choices[0].events.change[0]({ target: choices[0] });
  assert.deepEqual(ChatState.userInputRequestFor(run, 'one', draft).answers, [{ questionId: 'q', optionIndex: 0 }]);
  assert.equal(Object.hasOwn(draft[0], 'optionIndices'), false);
  choices.at(-1).checked = true; choices.at(-1).events.change[0]({ target: choices.at(-1) });
  const other = nodes(block, 'chat-user-input-other')[0]; other.value = 'typed'; other.events.input[0]({ target: other });
  assert.deepEqual(ChatState.userInputRequestFor(run, 'one', draft).answers, [{ questionId: 'q', text: 'typed' }]);
  ui.render(); assert.deepEqual(nodes(ui.panel(), 'chat-approval-choice').map(button => button.textContent), ['허용', '거절', '취소']);
});

test('false user-input delivery keeps the copied draft and never shows a sent answer', async t => {
  const h = await runtime(t); await h.question([question()]);
  const run = uiRun(h), input = run.pendingUserInputs[0];
  const identity = { conversationId: run.conversationId, runId: run.runId, userInputId: input.userInputId };
  let response = { ...identity, accepted: false, status: 'replySent' };
  const ui = surface({ run, fetchJson: async () => response }); ui.render();
  await choose(nodes(ui.panel(), 'chat-user-input-option')[0]);
  const key = `${run.conversationId}/${run.runId}/${input.userInputId}`;
  const before = clone(ui.drafts.get(key));
  for (const patch of [{ accepted: false }, { accepted: true, userInputId: 'another' }, { accepted: 'true' }]) {
    response = { ...identity, status: 'replySent', ...patch };
    assert.equal(await ui.replyUserInput(identity), false);
    assert.equal(input.status, 'pending'); assert.equal(input.replyPending, false);
    assert.deepEqual(ui.drafts.get(key), before);
    ui.render(); assert.doesNotMatch(ui.panel().textContent, /답변 전달됨/);
  }
  response = { ...identity, accepted: true, status: 'replySent' };
  await ui.replyUserInput(identity);
  assert.equal(input.status, 'replySent'); assert.equal(ui.drafts.has(key), false);
});

async function reportLimit(h, extra = {}) {
  await h.chat.handleNotification({ method: 'egdesk/engine/rateLimit', params: {
    threadId: h.result.conversationId, turnId: h.result.runId, engineId: 'claude',
    status: 'allowed_warning', window: 'fiveHour', windowMinutes: 300, resetsAt: NOW + 3600000,
    utilization: 0.87, usedPercent: 87, creditsRequired: false, ...extra,
  } });
}
// Execute the actual chat rendering block as well as the full activity panel.
function chatNotices(ui, run, usage = null) {
  const block = between('        const rateLimit = ChatState.runRateLimitNotice(run);', "        if (pending?.status === 'unconfirmed')");
  const conversation = ui.el('div');
  compile(block, { ChatState, run, conversation, el: ui.el, activeThread: ui.thread(),
    codex: { authStatus: { usage } }, codexBridge: { retryRun: () => assert.fail('automatic resend'), startLogin: () => assert.fail('automatic login') } });
  return conversation;
}

test('chat quota notice reuses existing inset classes without changing its words, role or actions', () => {
  for (const status of ['allowed', 'allowed_warning', 'rejected']) {
    const run = {engineId:'claude', status:'failed', rateLimit:{engineId:'claude', status,
      window:'fiveHour', usedPercent:100, resetsAt:NOW+3600000, creditsRequired:status==='rejected'}};
    const ui = surface({run});
    const notice = ChatState.runRateLimitNotice(run);
    const chat = chatNotices(ui, run);
    const rows = nodes(chat, 'chat-run-rate-limit');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].className, notice.level === 'limit' ? 'egd-codex-error' : 'egd-codex-run-status');
    assert.equal(rows[0].getAttribute('role'), 'status');
    assert.equal(rows[0].textContent, notice.text);
    assert.deepEqual(rows[0].style, {}, 'reuse the existing layout instead of adding inline geometry');
    assert.equal(all(chat).filter(node => node.tag === 'button').length, 0);
    assert.equal(ui.effects.requests.length, 0);
  }
});

test('run.rateLimit sanitizer, SSE, snapshots and SQLite history preserve bounded quota data without resending', async t => {
  const h = await runtime(t, { store: true });
  await reportLimit(h, { token: 'PRIVATE_LIMIT_FIELD' });
  let run = uiRun(h);
  const snapshot = h.chat.snapshot(h.result.conversationId);
  const fromSnapshot = ChatState.mergeChatSnapshot(ChatState.createChatProtocolState(), snapshot, 'ui')[0];
  const stored = localRuns(h).find(item => item.runId === run.runId);
  for (const value of [run, fromSnapshot, stored]) {
    assert.equal(value.rateLimit.usedPercent, 87);
    const notice = ChatState.runRateLimitNotice(value, NOW);
    assert.equal(notice.level, 'warn'); assert.equal(notice.action, null);
    assert.equal(notice.usedPercent, 87); assert.match(notice.text, /87%/);
    assert.ok(notice.text.includes(ChatState.formatResetClock(NOW + 3600000, NOW)));
    assert.equal(JSON.stringify(value.rateLimit).includes('PRIVATE_LIMIT_FIELD'), false);
  }
  await reportLimit(h, { status: 'rejected', usedPercent: 100, utilization: 1, creditsRequired: true });
  run = uiRun(h);
  const notice = ChatState.runRateLimitNotice(run, NOW);
  assert.equal(notice.level, 'limit'); assert.match(notice.text, /추가 사용량/);
  assert.equal(notice.action, null);
  const ui = surface({ run, auth: { usage: { resetsAt: NOW + 99999999 } } });
  ui.render();
  assert.equal(nodes(ui.panel(), 'chat-run-rate-limit').length, 1);
  assert.equal(all(ui.panel()).filter(node => node.className === 'egd-codex-error').length, 0, 'quota error is not duplicated');
  run.status = 'failed';
  const chat = chatNotices(ui, run);
  assert.equal(nodes(chat, 'chat-run-rate-limit').length, 1);
  assert.equal(nodes(chat, 'chat-run-error').length, 0);
  assert.equal(all(chat).filter(node => node.tag === 'button').length, 0);
  assert.equal(ui.effects.requests.length, 0); assert.equal(ui.effects.timers, 0);
  assert.equal(h.transports[0].sent.length, 1); assert.deepEqual(h.codexCalls, []); assert.equal(h.timers.length, 0);
  const past = ChatState.runRateLimitNotice(run, NOW + 7200000);
  assert.match(past.resetLabel, /보고된/); assert.equal(past.action, null, 'a passed reset never schedules a retry');
  const count = h.events.length;
  await reportLimit(h, { status: 'PRIVATE_LIMIT_FIELD' });
  assert.equal(h.events.length, count);
  await reportLimit(h, { status: 'allowed_warning', window: 'PRIVATE_LIMIT_FIELD', windowMinutes: Infinity,
    resetsAt: 'PRIVATE_LIMIT_FIELD', usedPercent: -5, utilization: 5, overageStatus: 'PRIVATE_LIMIT_FIELD', creditsRequired: 'true' });
  run = uiRun(h);
  assert.equal(run.rateLimit.usedPercent, 0); assert.equal(run.rateLimit.resetsAt, null);
  assert.equal(run.rateLimit.creditsRequired, false);
  assert.equal(JSON.stringify(run.rateLimit).includes('PRIVATE_LIMIT_FIELD'), false);
  const beforeAllowed = h.chat.snapshot(h.result.conversationId);
  await reportLimit(h, { status: 'allowed', usedPercent: 8, creditsRequired: false });
  const state = ChatState.createChatProtocolState();
  for (const event of h.events) ChatState.reduceChatEvent(state, event, ['claude', 'codex']);
  const current = state.runs[ChatState.runKey(run.conversationId, run.runId)];
  ChatState.mergeChatSnapshot(state, beforeAllowed, 'ui');
  assert.equal(ChatState.runRateLimitNotice(current, NOW).level, 'ok', 'older snapshot does not rewind a newer event');
  assert.equal(current.rateLimit.usedPercent, 8);
  assert.equal(h.transports[0].sent.length, 1);
});

test('Claude quota errors never borrow Codex account resets, while Codex keeps its usage fallback', () => {
  const usage = { resetsAt: Date.now() + 3600000 };
  const run = { conversationId: 'c', runId: 'r', clientThreadId: 'ui', status: 'failed', error: { kind: 'quota', message: 'quota' },
    pendingApprovals: [], pendingUserInputs: [] };
  const ui = surface({ run, auth: { usage } });
  ui.render();
  const clock = ChatState.formatResetClock(usage.resetsAt);
  assert.equal(ui.panel().textContent.includes(clock), false);
  assert.equal(chatNotices(ui, run, usage).textContent.includes(clock), false);
  ui.thread().engineId = 'codex';
  assert.ok(chatNotices(ui, run, usage).textContent.includes(clock));
  for (const marker of [{ engineId: 'claude' }, { engine: { id: 'claude' } }, { error: { kind: 'quota', origin: 'claude' } }]) {
    const marked = { ...run, ...marker };
    assert.equal(chatNotices(ui, marked, usage).textContent.includes(clock), false);
  }
});

test('explicit Claude Context blocks before auth guard, capture, dispatch or any draft/selection change', async () => {
  for (const selection of [{ inputSources: [{ ...fileInput(), resolverRef: 'ref' }] },
    { briefingInputs: [{ snapshotId: 'briefing' }] }, { picked: ['context-choice'] }]) {
    const ui = surface({ thread: { ...selection }, auth: { isLoggedIn: false } });
    ui.state.codex.connected = false;
    ui.state.codex.engines = [{ id: 'codex', status: 'ready' }, { id: 'claude', status: 'offline' }];
    ui.state.contextSuggest.byThread.ui = { picked: selection.picked || [], resolution: { resolutionId: 'keep-choice' } };
    const before = clone({ thread: ui.thread(), drafts: ui.state.codex.threadDrafts, context: ui.state.contextSuggest });
    await ui.sendMessage();
    assert.equal(ui.thread().sendError, ChatState.claudeContextSendErrorText('CLAUDE_CONTEXT_UNSUPPORTED'));
    const { sendError, ...after } = ui.thread();
    assert.deepEqual(after, before.thread);
    assert.deepEqual(ui.state.codex.threadDrafts, before.drafts);
    assert.deepEqual(ui.state.contextSuggest, before.context);
    assert.deepEqual(ui.effects.capture, []); assert.deepEqual(ui.effects.requests, []); assert.equal(ui.effects.ready, 0);
    assert.deepEqual(ui.protocol.requests, {}); assert.equal(ui.state.codex.recentEngineId, 'codex');
  }
  assert.equal(ChatState.claudeContextSendErrorText('UNKNOWN'), null);
  assert.equal(ChatState.claudeContextSendErrorText('CLAUDE_CONTEXT_UNSUPPORTED'),
    '현재 Claude 연결에서는 선택한 자료를 사용할 수 없어 보내지 않았습니다. 자료를 제외한 뒤 다시 보내세요.');
});

test('plain Claude send carries explicit intent without implicit Codex Context or fallback', async () => {
  const ui = surface();
  ui.state.codex.engines = [{ id: 'codex', status: 'offline' }, claudeRow()];
  ui.state.codex.authStatus.isLoggedIn = false;
  ui.state.codex.connected = false;
  ui.state.contextSuggest.byThread.ui = { picked: [], accountKey: ChatState.codexAccountKey(ui.state.codex.authStatus),
    receivedAt: Date.now(), resolution: { resolutionId: 'unused-suggestion', candidates: [] } };
  await ui.sendMessage();
  const send = ui.effects.requests.filter(request => request.path === '/chat/send');
  assert.equal(send.length, 1); assert.equal(send[0].body.engineId, 'claude');
  assert.deepEqual(send[0].body.contextSnapshotIds, []);
  assert.equal(Object.hasOwn(send[0].body, 'contextCapabilities'), false);
  assert.equal(Object.hasOwn(send[0].body, 'contextResolution'), false);
  assert.equal(ui.thread().engineId, 'claude');
  assert.equal(ui.state.codex.threadDrafts.ui, '  keep my draft  ', 'definite refusal restores the original text');
});

test('Codex plain send keeps its Context capability and selection payload', async () => {
  const ui = surface({ thread: { engineId: 'codex', inputSources: [fileInput()] } });
  await ui.sendMessage();
  const send = ui.effects.requests.find(request => request.path === '/chat/send').body;
  assert.equal(send.engineId, 'codex');
  assert.deepEqual(send.contextSnapshotIds, ['capture-file']);
  assert.deepEqual(send.contextCapabilities, { read: true, reader: true, publishBriefing: true });
});

test('Claude unavailable engine/profile gates send and resume without borrowing Codex login', async () => {
  for (const setup of [ui => { ui.state.codex.engines = []; },
    ui => { ui.state.codex.engines[1].status = 'offline'; },
    ui => { ui.state.codex.engines[1].profiles[0].auth.status = 'signedOut'; },
    ui => { ui.state.codex.engines[1].profiles = []; }]) {
    const ui = surface(); setup(ui);
    await ui.sendMessage(); await ui.refresh(ui.thread(), true);
    assert.deepEqual(ui.effects.requests, []); assert.deepEqual(ui.effects.capture, []);
    assert.equal(ui.state.codex.threadDrafts.ui, '  keep my draft  ');
  }
  const ui = surface({ thread: { conversationId: 'c', bindingState: 'server-check-required' }, auth: { isLoggedIn: false },
    fetchJson: async () => ({ conversationId: 'c', runs: [], historyComplete: true }) });
  await ui.refresh(ui.thread(), true);
  assert.deepEqual(ui.effects.requests[0], { path: '/chat/resume', body: { conversationId: 'c', clientThreadId: 'ui', engineId: 'claude' } });
});

test('backend Context HTTP409 maps fixed text and safely restores text and selections without resend', async () => {
  for (const engineId of ['claude', 'codex']) {
    const inputs = engineId === 'codex' ? [fileInput()] : [];
    const briefings = engineId === 'codex' ? [{ snapshotId: 'briefing' }] : [];
    const ui = surface({ thread: { engineId, inputSources: inputs, briefingInputs: briefings }, fetchJson: async () => {
      throw Object.assign(new Error('PRIVATE_BACKEND_DETAIL'), { code: 'CLAUDE_CONTEXT_UNSUPPORTED', status: 409, accepted: false });
    } });
    ui.state.contextSuggest.byThread.ui = { resolution: { resolutionId: 'retained' }, picked: [] };
    const before = clone(ui.state.contextSuggest);
    await ui.sendMessage();
    assert.equal(ui.thread().sendError, ChatState.claudeContextSendErrorText('CLAUDE_CONTEXT_UNSUPPORTED'));
    assert.equal(ui.state.codex.threadDrafts.ui, '  keep my draft  '); assert.equal(ui.state.codex.draft, '  keep my draft  ');
    assert.deepEqual(ui.thread().inputSources, inputs); assert.deepEqual(ui.thread().briefingInputs, briefings);
    assert.deepEqual(ui.state.contextSuggest, before); assert.equal(ui.thread().engineId, engineId);
    assert.deepEqual(ui.thread().messages, [], 'a definite refusal leaves no outgoing or pending user bubble');
    assert.ok(Object.values(ui.protocol.requests).every(request => request.status === 'failed'));
    assert.equal(ui.effects.requests.length, 1); assert.equal(ui.effects.timers, 0);
    assert.equal(JSON.stringify(ui.state).includes('PRIVATE_BACKEND_DETAIL'), false);
  }
});

test('late backend409 cannot overwrite a newer composer draft or input selection', async () => {
  let reject;
  const ui = surface({ fetchJson: () => new Promise((_, fail) => { reject = fail; }) });
  let failure;
  const sending = ui.sendMessage().catch(error => { failure = error; });
  for (let i = 0; i < 20 && !reject && !failure; i++) await new Promise(resolve => setImmediate(resolve));
  if (failure) throw failure;
  assert.equal(typeof reject, 'function', 'production send reaches the pending HTTP request');
  ui.state.codex.threadDrafts.ui = 'newer text'; ui.state.codex.threadDraftRevisions.ui++;
  ui.thread().inputSources = [fileInput('new-input')];
  reject(Object.assign(new Error('refused'), { code: 'CLAUDE_CONTEXT_UNSUPPORTED', status: 409 }));
  await sending;
  assert.equal(ui.state.codex.threadDrafts.ui, 'newer text');
  assert.deepEqual(ui.thread().inputSources, [fileInput('new-input')]);
  assert.equal(ui.effects.requests.length, 1);
});

test('actual HTTP error reader and accepted:false responses remove only the refused Context bubble', async () => {
  const previous = { id: 'existing', role: 'user', content: 'earlier message', status: 'complete' };
  for (const httpError of [true, false]) {
    const payload = { accepted: false, code: 'CLAUDE_CONTEXT_UNSUPPORTED', error: 'PRIVATE_SERVER_DETAIL' };
    const fetchJson = compile(`${between('    const fetchJson = async', '\n\n    // One catalog read')}\nreturn fetchJson;`, {
      fetch: async () => ({ ok: !httpError, status: httpError ? 409 : 200,
        text: async () => JSON.stringify(payload), json: async () => payload }),
    });
    const ui = surface({ thread: { messages: [clone(previous)], profileEnabled: true }, fetchJson });
    await ui.sendMessage();
    assert.deepEqual(ui.thread().messages, [previous]);
    assert.equal(ui.thread().sendError, ChatState.claudeContextSendErrorText(payload.code));
    assert.equal(ui.state.codex.threadDrafts.ui, '  keep my draft  ');
    assert.ok(Object.values(ui.protocol.requests).every(request => request.status === 'failed'));
    assert.equal(ui.effects.requests.length, 1); assert.equal(ui.effects.timers, 0);
    assert.equal(ui.effects.requests[0].body.engineId, 'claude');
  }
});

test('a late Context error cannot remove a request already accepted by SSE', async () => {
  let ui;
  ui = surface({ fetchJson: async (_path, options) => {
    const { requestId } = JSON.parse(options.body);
    const event = { type: 'chat.event', v: 2, event: 'run.started', streamId: 'accepted-stream', seq: 1,
      engineId: 'claude', conversationId: 'accepted-conversation', runId: 'accepted-run', requestId, clientThreadId: 'ui', details: {} };
    assert.ok(ChatState.reduceChatEvent(ui.protocol, event, ['claude']));
    throw Object.assign(new Error('refused'), { code: 'CLAUDE_CONTEXT_UNSUPPORTED', status: 409, accepted: false });
  } });
  await ui.sendMessage();
  assert.equal(ui.thread().messages.length, 1);
  assert.equal(Object.values(ui.protocol.requests)[0].status, 'accepted');
  assert.equal(ui.state.codex.threadDrafts.ui, '');
  assert.equal(ui.effects.requests.length, 1);
});

test('runtime Claude Context HTTP409 precedes native dispatch; empty Context stays a distinct request', async t => {
  const h = await runtime(t);
  for (const context of [{ contextSnapshotIds: ['snapshot'] }, { contextCapabilities: { read: true } },
    { contextResolution: { resolutionId: 'selection', chosen: ['source'] } }]) {
    await assert.rejects(h.chat.send({ clientThreadId: 'blocked-ui', requestId: 'blocked', engineId: 'claude', message: 'keep', ...context }),
      error => error.code === 'CLAUDE_CONTEXT_UNSUPPORTED' && error.httpStatus === 409);
  }
  assert.equal(h.transports.length, 1); assert.equal(h.transports[0].sent.length, 1);
  assert.deepEqual(h.codexCalls, []);
  await h.chat.send({ clientThreadId: 'plain-ui', requestId: 'plain', engineId: 'claude', message: 'plain', contextSnapshotIds: [] });
  assert.equal(h.transports.length, 2); assert.equal(h.transports[1].sent.length, 1);
});
