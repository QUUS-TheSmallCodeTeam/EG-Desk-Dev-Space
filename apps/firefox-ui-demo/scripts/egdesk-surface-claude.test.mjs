import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileFunction } from 'node:vm';
import { Readable } from 'node:stream';
import { webcrypto } from 'node:crypto';
import { readSurfaceSource } from './egdesk-surface-source.mjs';
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';
import * as ChatRunResult from '../overlay/resources/EGDeskChatRunResult.sys.mjs';
import * as ChatChangeReview from '../overlay/resources/EGDeskChatChangeReview.sys.mjs';
import * as InputContext from '../overlay/resources/EGDeskInputContext.sys.mjs';
import { CodexChatRuntime } from '../helper/codex-chat-runtime.mjs';
import { createCodexEngineAdapter } from '../helper/codex-engine-adapter.mjs';
import { createClaudeEngineAdapter } from '../helper/claude-engine-adapter.mjs';
import { openChatStore } from '../helper/egdesk-chat-store.mjs';
import { describeClaudeEngine, publicEngineRow } from '../helper/engine-registry.mjs';
import { ContextRuntime } from '../helper/egdesk-context-runtime.mjs';
import { estimateClaudeReaderInput } from '../helper/egdesk-claude-reader.mjs';
import { ImmutableContextStore, hashContent } from '../helper/egdesk-context-store.mjs';
import { createContextHttpHandler } from '../helper/egdesk-context-http.mjs';
import { createChatEngineAuth } from '../helper/codex-bridge-engine-auth.mjs';
import { createChatHttpHandler } from '../helper/codex-bridge-http.mjs';
import * as BoardThread from '../overlay/resources/EGDeskBoardThread.sys.mjs';

// Execute the current production functions, including el() and the bridge
// handlers. Firefox bootstrap, browser/OS input and real engines never run.
const source = readSurfaceSource();
const clone = value => JSON.parse(JSON.stringify(value));
const NOW = 1800000000000;
const claudeRow = (patch = {}) => ({ ...publicEngineRow(describeClaudeEngine({ installed: true, version: '2.1.300',
  auth: { status: 'signedIn', method: 'claudeai', account: 'test@example.invalid' } }, { capabilities: ['stream', 'resume'] })), ...patch });
const fileInput = (id = 'file') => ({ id, kind: 'file', label: '선택한 파일', sourceRef: { kind: 'file', path: `/work/${id}.txt` } });
const b2Capability = { contract: 'egdesk-context-b2', engineId: 'claude', engineProfileId: 'claude-default',
  expectedContextScope: 'test-server-issued-opaque-context-expectation',
  selectedAttachments: true, immutableRead: true, nativeReader: false, tools: ['egdesk_list_context', 'egdesk_read_source'] };
const readerCapability = { ...b2Capability, nativeReader:true, largeReader:true,
  reader:{ready:true,engineId:'claude',code:null,capacitySource:'native-observation',metadataHash:'fixture-capacity-proof'} };
const captureReply = body => ({ captures: body.attachments.map(item => ({ id: item.id, sourceId: `stored-${item.id}`,
  snapshotId: `stored-${item.id}`, hash: `hash-${item.id}`, sourceRef: item.sourceRef, captureScope: item.captureScope })) });
function functionSource(name, indent = '  ') {
  const match = source.match(new RegExp(`^${indent}(?:async )?function ${name}\\([^]*?^${indent}\\}`, 'm'));
  assert.ok(match, `production function ${name}`);
  return match[0];
}
function methodSource(name) {
  const match = source.match(new RegExp(`^      (?:async )?${name}\\([^]*?^      \\},`, 'm'));
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
// Extract the real controller and give each fixture its own animation-frame
// queue. No Firefox bootstrap, shared pending state or replacement helper code.
function productionController(name, ...args) {
  const frames = [];
  const create = compile(`${functionSource(name)}\nreturn ${name};`, {});
  const instance = create(...args, { schedule: callback => { frames.push(callback); return frames.length; } });
  return { instance, pendingFrames: () => frames.length,
    flushFrame() { const ready = frames.splice(0); ready.forEach(callback => callback()); return ready.length; } };
}
// sendMessage and serializeDeskSnapshot share this production draft closure.
// Instantiate its real map, constants and normalizer for each isolated surface.
const requestProjectDraftSource = between('  const chatRequestProjectDisplays = ', '  function chatRequestProjectSelection(');
const bridgeNormalizeSource = between('    const normalizeThreads = () => {', '    const emit = () => {');
const bridgeWatchSource = between('    const memoReadWatches = new Map();', '    const confirmedLegacyImports = new Set();');
const bridgeNoticeSource = between('    const clearMemoManualSendNotice = ', '    connect();');
// Keep the production subscription/notification closure, without installing
// Firefox rendering or persistence. emit's listener loop is not a copied bus.
const bridgeNotifySource = between('      for (const listener of listeners) {', '      renderCodexActivityPanel();',
  source.indexOf('    const emit = () => {'));
const agentProfileSource = between('  const DEFAULT_CODEX_AGENT_PROFILE_ID = ', '  function codexThreadKindMeta(');

class Node {
  constructor(tag, text = '') {
    this.tag = tag; this.text = text; this.children = []; this.attributes = {};
    this.dataset = {}; this.style = {}; this.events = {}; this.disabled = false;
    this.checked = false; this.value = ''; this.className = ''; this.scrollTop = 0; this.scrollLeft = 0; this.isConnected = true; this.scrollHeight = 40; this.parent = null;
  }
  setAttribute(key, value) { this.attributes[key] = String(value); if (key === 'disabled') this.disabled = true;
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(name, fn) { (this.events[name] ||= []).push(fn); }
  removeEventListener(name, fn) { this.events[name] = (this.events[name] || []).filter(listener => listener !== fn); }
  appendChild(node) { node.remove(); node.parent = this; this.children.push(node); return node; }
  append(...nodes) { nodes.forEach(node => this.appendChild(node)); }
  prepend(...nodes) { for (const node of nodes.reverse()) { node.remove(); node.parent = this; this.children.unshift(node); } }
  replaceChildren(...nodes) { for (const child of this.children) child.parent = null; this.children = []; this.text = ''; nodes.forEach(node => this.appendChild(node)); }
  replaceWith(node) { const parent = this.parent; if (!parent) return; const index = parent.children.indexOf(this); node.remove(); parent.children[index] = node; node.parent = parent; this.parent = null; }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  get parentElement() { return this.parent; }
  matches(selector) {
    return selector.split(',').some(part => {
      const selected = part.trim(), attribute = selected.match(/^\[([\w-]+)(?:=["']([^"']*)["'])?\]$/);
      if (attribute) {
        const name = attribute[1], value = name.startsWith('data-')
          ? this.dataset[name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase())] : this.getAttribute(name);
        return value != null && (attribute[2] === undefined || String(value) === attribute[2]);
      }
      return selected.startsWith('.') ? this.className.split(' ').includes(selected.slice(1))
        : selected.startsWith('#') ? this.getAttribute('id') === selected.slice(1) : this.tag === selected;
    });
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const space = selector.indexOf(' ');
    if (space > 0) return this.querySelectorAll(selector.slice(0, space)).flatMap(node => node.querySelectorAll(selector.slice(space + 1)));
    return this.children.flatMap(node => [...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector)]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  get textContent() { return this.text + this.children.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  fire(type, data = {}) { return Promise.all((this.events[type] || []).map(fn => fn({ target: this, preventDefault() {}, stopPropagation() {}, ...data }))); }
}
const all = node => [node, ...node.children.flatMap(all)];
const nodes = (node, testid) => all(node).filter(item => item.dataset.testid === testid);
const attributes = node => all(node).map(item => ({ attributes: item.attributes, data: item.dataset }));
const choose = async (node, checked = true) => { node.checked = checked; await node.fire('change'); };
const type = async (node, text) => { node.value = text; await node.fire('input'); };

function surface({ run = null, thread = {}, auth = {}, fetchJson = async () => ({ accepted: false }), ensureReady = async () => true, nativeReady = false, realProjection = false,
  realCapture = false, captureChatInputs = async () => assert.fail('unexpected live capture'),
  captureManagedFileInput = async () => assert.fail('unexpected managed file') } = {}) {
  const root = new Node('root');
  const document = { documentElement: root, activeElement: null, defaultView: { getComputedStyle: () => ({ maxHeight: '240' }) },
    createElement: tag => Object.assign(new Node(tag), { ownerDocument: document }),
    createElementNS: (namespaceURI, tag) => Object.assign(new Node(tag), { ownerDocument: document, namespaceURI }),
    createTextNode: text => new Node('#text', text), getElementById: id => root.querySelector(`#${id}`),
    querySelectorAll: selector => root.querySelectorAll(selector), querySelector: selector => root.querySelector(selector) };
  const initial = { id: 'ui', clientThreadId: 'ui', type: 'dm', title: 'QA 대화', engineId: 'claude', messages: [], inputSources: [], briefingInputs: [], ...thread };
  const protocol = ChatState.createChatProtocolState();
  if (run) protocol.runs[ChatState.runKey(run.conversationId, run.runId)] = run;
  const state = { panTarget: {}, agenda: {}, surface: {}, boards: {}, contextSuggest: { byThread: {} }, codex: {
    threads: [initial], activeThreadId: 'ui', activityThreadId: 'ui', chatProtocol: protocol,
    threadDrafts: { ui: '  keep my draft  ' }, threadDraftRevisions: { ui: 0 }, recentEngineId: 'codex',
    engines: [{ id: 'codex', status: 'ready' }, claudeRow()],
    authStatus: { isLoggedIn: true, accountId: 'test-account', ...auth }, connected: true, liveRevision: 0,
  } };
  const effects = { emits: 0, capture: [], requests: [], projectRequests: [], ready: 0, timers: 0, synced: [], logs: [], revoked: [] };
  const epochScope = ChatState.createChatEpochScope();
  const userInputDrafts = new Map();
  const globals = { ChatState, BoardThread, ChatRunResult, ChatChangeReview, InputContext, document, state, protocol, userInputDrafts, epochScope, effects, realProjection,
    window: { AbortController, crypto: webcrypto, setTimeout: () => 1, clearTimeout() {} }, queueMicrotask,
    captureChatInputs, captureManagedFileInput, boardNotice: text => effects.logs.push(text),
    SELF_MEMBER: 'self', cloneJson: clone, formatMessageTime: String, contextBoardTitle: () => '',
    openChatFileReference: () => assert.fail('unexpected file open'), currentViewportAgendaLabel: () => '',
    serializeCardState: () => assert.fail('unexpected card'), serializeShapeState: () => assert.fail('unexpected shape'),
    updateThreadById: (id, updater) => { state.codex.threads = state.codex.threads.map(item => item.id === id ? updater(item) : item); },
    appendMessageToThread: (id, message) => { state.codex.threads.find(item => item.id === id).messages.push(message); },
    ensureNativeReadyForSend: async item => { effects.ready++; return ensureReady(item); },
    captureThreadInputs: async (item, inputs) => { effects.capture.push(clone(inputs)); return inputs.map(input => ({ snapshotId: `capture-${input.id}`, sourceId: input.id })); },
    browserToolSelectedSources: () => [], rootSseReady: () => ({ sourceReady: true }),
    codexThreadAgentProfile: () => null, codexThreadRuntimeConfig: () => ({}),
    syncProtocolRun: value => {
      effects.synced.push(value);
      if (realProjection) globals.updateThreadById(value.localThreadId, thread => ({ ...thread,
        ...ChatState.nativeBindingForRun(thread, value), conversationId: value.conversationId,
        messages: ChatState.projectRunMessages(thread.messages, value) }));
    }, expireContextSuggestions: () => assert.fail('unexpected context expiry'),
    revokeBrowserToolRunImmediately: (run, item) => effects.revoked.push([run.runId, item.id]),
    setTimeout: () => { effects.timers++; assert.fail('automatic timer'); }, setInterval: () => assert.fail('automatic timer'),
    console: Object.fromEntries(['log', 'warn', 'error', 'debug', 'info'].map(name => [name, (...values) => effects.logs.push(values)])),
    fetchJson: async (path, options) => {
      if (path === '/v1/files/projects/room-default') {
        const body = JSON.parse(options.body); effects.projectRequests.push({ path, body });
        return { ok: true, result: { roomId: body.roomId, inheritance: null, override: null, project: null, source: null, status: 'none' } };
      }
      effects.requests.push({ path, body: options?.body ? JSON.parse(options.body) : null }); return fetchJson(path, options);
    },
    refreshing: new Map(), resumedNativeBindings: new Set(),
  };
  const definitions = ['el', 'getCodexThreadById', 'getActiveCodexThread', 'getCodexThreadDraft', 'createCodexMessage',
    'uniqueNames', 'normalizeHudView', 'normalizeCodexAgentProfileId', 'codexServerAgentProfile', 'codexAgentProfile',
    'buildThreadSubtitle', 'createCodexThread', 'defaultCodexThreads',
    'chatRequestProjectSelection', 'chatRoomProjectState', 'chatRoomProjectSendBlock', 'memoAskRuntimeIdentity',
    'createAcceptedReceiptWatch', 'rememberAcceptedInputReceipt', 'acceptedInputReceipt', 'visibleInputAnswer',
    'briefingInputReferences', 'historyReadReferenceCurrent', 'inputDeliveryProof', 'inputDeliveryMatches',
    'inputAuthorizationFailure', 'invalidateInputReadOnDenial', 'openChatInputPanel', 'briefingRangeIssue',
    'createChatProjectScope', 'normalizeChatRoomProjectDefault', 'snapshotChatRoomProjectExpectation', 'chatRoomProjectExpectation', 'chatRoomProjectTargetsMatch',
    'codexRuns', 'codexRunLabel', 'codexUserInputBlock', 'pruneUserInputDrafts', 'contextResolverRecordSection',
    'codexSubAgentSection', 'codexActivityDetailTarget', 'codexCommandInfo', 'createCodexActivityReadScope',
    'replaceCodexActivityDetails', 'createCodexActivityDetailsView', 'renderCodexActivityPanel', 'serializeDeskSnapshot', 'codexMessageAvatarFace',
    'codexAgentWorkingRow'].map(name => functionSource(name)).join('\n');
  if (nativeReady) delete globals.ensureNativeReadyForSend;
  if (realCapture) delete globals.captureThreadInputs;
  const api = compile(`${requestProjectDraftSource}\n${agentProfileSource}\n${definitions}
    ${source.match(/^  let codexProfileCatalog = .*;$/m)[0]}
    ${source.match(/^  const TAG = .*;$/m)[0]}
    ${functionSource('threadBusy', '    ')}\n${functionSource('refreshConversation', '    ')}
    ${functionSource('requireClaudeContext', '    ')}
    ${realCapture ? functionSource('captureThreadInputs', '    ') : ''}
    ${nativeReady ? functionSource('ensureNativeReadyForSend', '    ') : ''}
    let activityPanelComposing = false, activityPanelDeferred = false, activityDetailsGeneration = 0, activityDetailsView = null;
    const listeners = new Set();
    ${bridgeWatchSource}
    ${bridgeNormalizeSource}
    const emit = () => { effects.emits++; if (realProjection) normalizeThreads(); for (const watch of memoReadWatches.values()) observeMemoReadWatch(watch); ${bridgeNotifySource} };
    ${bridgeNoticeSource}
    ${source.match(/^  const userInputDraftKey = .*;$/m)[0]}
    const bridge = { ${['subscribe', 'captureManualSendOwner', 'createActivityReadScope', 'createProjectScope', 'readRoomProjectDefault', 'prepareRoomProjectSend', 'prepareBriefingInputSend', 'replyApproval', 'replyUserInput', 'sendMessage', 'captureInputs', 'inspectInput', 'readInput', 'setThreadEngine', 'interrupt'].map(methodSource).join(',\n')} };
    return { ...bridge, render: renderCodexActivityPanel, question: codexUserInputBlock, serialize: serializeDeskSnapshot,
      refresh: refreshConversation, workingRow: codexAgentWorkingRow, projectBlock: chatRoomProjectSendBlock,
      notify: emit, syncRun: syncProtocolRun, listenerCount: () => listeners.size, el,
      visibleAnswer: visibleInputAnswer, deliveryProof: inputDeliveryProof,
      historyCurrent: historyReadReferenceCurrent, inputReceipt: acceptedInputReceipt };`, globals);
  state.codexBridge = { ...api, refreshConversation: () => {} };
  return { ...api, state, protocol, effects, epochScope, drafts: userInputDrafts, document, root, window:globals.window,
    thread: () => state.codex.threads[0], panel: () => document.getElementById('egd-codex-activity-panel') };
}

function composer(ui) {
  const viewport = ui.composerViewport ||= productionController('createChatComposerViewport');
  const block = between('            const manualOwner = ', "            input.addEventListener('input'");
  // Keep the real icon helper, its SVG builder and source shapes in the same
  // VM scope as the extracted production composer, just as in the app.
  const icons = `${functionSource('svgEl')}\n${between('  const DESK_ICON_SHAPES = {', '  function normalizeSourcePart(')}`;
  const controls = compile(`${functionSource('chatConversationIdentity')}\nconst activeIdentity = chatConversationIdentity(activeThread, null, ChatState.chatEngineChipView(activeThread, codex));\n${functionSource('getCodexThreadDraft')}\n${icons}\n${block}\nreturn {input, sendButton, resizeComposer};`, {
    document: ui.document, body: {}, el: ui.el, ChatState, BoardThread, activeThread: ui.thread(), codex: ui.state.codex, codexBridge: ui,
    chatRoomProjectSendBlock: ui.projectBlock, composerViewport: viewport.instance,
    compositionInProgress: false,
  });
  controls.resizeComposer();
  return { ...controls, viewport };
}
function emptyChat(ui) {
  const block = between("        if (!hasConversation && activeThread.type === 'dm') {", '        } else if (!hasConversation) {') + '\n}';
  const messages = ui.el('div');
  compile(block, { el: ui.el, ChatState, BoardThread, activeThread: ui.thread(), codex: ui.state.codex,
    activeEngine: ChatState.chatThreadReadiness(ui.thread(), ui.state.codex), messages, hasConversation: false, authCard: null,
    chatRequestProjectSelection: () => ({ invalid: false }), chatRoomProjectSendBlock: ui.projectBlock,
    codexBridge: { startLogin: () => assert.fail('Claude opened Codex login'), refreshAuthStatus: () => {} } });
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
    ChatState, BoardThread, state: ui.state, protocol: ui.protocol, userInputDrafts: ui.drafts, document: ui.document, effects,
    epochScope: { ...ui.epochScope, reset: (scope, profile) => { effects.reset++; effects.resetScopes.push(scope); ui.epochScope.reset(scope, profile); } },
    clearBrowserToolTransport: () => effects.cleared++,
    resumedNativeBindings: new Set(), refreshing: new Map(), chatBindingNonce: () => 'new-codex-binding',
    normalizeThreads: () => {}, emit: ui.notify, scheduleReconnect: () => effects.reconnect++,
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
  const sendIcon = controls.sendButton.querySelector('svg');
  assert.ok(sendIcon, 'the real send icon is rendered');
  assert.equal(sendIcon.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(sendIcon.getAttribute('aria-hidden'), 'true');
  assert.equal(sendIcon.getAttribute('viewBox'), '0 0 24 24');
  assert.equal(sendIcon.querySelector('path')?.getAttribute('d'), 'M12 19V5m-5 5 5-5 5 5');
  assert.equal(sendIcon.querySelector('rect'), null, 'the fallback square is not the send icon');
  const empty = emptyChat(ui);
  assert.match(empty.textContent, /첫 메시지를 보내세요/);
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

test('composer excerpt executes real viewport preservation and keeps pending restores isolated between surfaces', () => {
  const ui = surface(), otherUi = surface(), first = composer(ui), second = composer(otherUi);
  assert.notEqual(first.viewport.instance, second.viewport.instance);
  assert.equal(composer(ui).viewport.instance, first.viewport.instance, 'one controller persists within one Chat surface');
  const messages = ui.el('div', { class: 'egd-codex-messages' });
  const pane = ui.el('div', { class: 'egd-codex-conversation-pane' }, messages);
  const footer = ui.el('div', { class: 'egd-codex-footer' }, first.input, first.sendButton);
  const main = ui.el('div', { class: 'egd-codex-chat-main' }, pane, footer);
  ui.root.appendChild(main);
  Object.assign(main, { clientHeight: 420, offsetHeight: 420 });
  Object.assign(footer, { offsetHeight: 40 });
  Object.assign(messages, { clientHeight: 300, offsetHeight: 300 });
  Object.assign(first.input, { clientHeight: 40, offsetHeight: 40, scrollHeight: 400, scrollTop: 17, scrollLeft: 5 });
  let height = first.input.style.height, autoResets = 0;
  // Explicit DOM model: layout-only auto height can reset native scroll. The
  // real resize/controller must restore it, not a fixture callback or stub.
  Object.defineProperty(first.input.style, 'height', { configurable: true,
    get: () => height, set(value) {
      height = value;
      first.input.clientHeight = first.input.offsetHeight = value === 'auto' ? 40 : Number.parseFloat(value);
      if (value === 'auto') { autoResets++; first.input.scrollTop = 0; first.input.scrollLeft = 0; }
    } });
  first.resizeComposer();
  assert.equal(autoResets, 1); assert.equal(main.dataset.compactComposer, 'true');
  assert.equal(first.input.style.height, '80px'); assert.equal(first.input.style.overflowY, 'auto');
  assert.deepEqual([first.input.scrollTop, first.input.scrollLeft], [17, 5]);
  assert.equal(first.sendButton.disabled, false, 'real readiness remains part of the same resize');
  first.resizeComposer(false);
  assert.equal(autoResets, 2); assert.deepEqual([first.input.scrollTop, first.input.scrollLeft], [0, 0], 'native-edit resize does not replay layout scroll');
  first.input.scrollTop = 19; second.input.scrollTop = 31;
  for (const controls of [first, second]) {
    const snapshot = controls.viewport.instance.snapshot(controls.input);
    controls.input.scrollTop = 0;
    controls.viewport.instance.restore(controls.input, snapshot);
    assert.equal(controls.viewport.pendingFrames(), 1);
    assert.equal(controls.viewport.instance.snapshot(controls.input).scrollTop, snapshot.scrollTop, 'pending intent survives before the frame');
  }
  first.viewport.instance.cancel(first.input);
  assert.equal(first.viewport.flushFrame(), 1); assert.equal(first.input.scrollTop, 0);
  assert.equal(second.viewport.pendingFrames(), 1, 'another surface cancellation cannot consume this frame');
  assert.equal(second.viewport.flushFrame(), 1); assert.equal(second.input.scrollTop, 31);
  first.viewport.instance.dispose(); second.viewport.instance.dispose();
  assert.deepEqual(ui.effects.requests, []); assert.deepEqual(otherUi.effects.requests, []);
});

test('Claude does not schedule, request or display Codex Context suggestions', async () => {
  const ui = surface();
  const definitions = ['requestContextSuggestions', 'resolveContextSuggestions'].map(name => functionSource(name, '    ')).join('\n');
  const api = compile(`${functionSource('getCodexThreadById')}\n${functionSource('buildContextSuggestions')}\n${definitions}
    return {request:requestContextSuggestions, resolve:resolveContextSuggestions, render:buildContextSuggestions};`, {
    state:ui.state, ChatState, BoardThread, window:{setTimeout:()=>assert.fail('Claude scheduled Codex Context'), clearTimeout:()=>{}},
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
      ChatState, BoardThread, InputContext, epochScope:ui.epochScope, state:ui.state,
      getCodexThreadById: (state, id) => state.threads.find(thread => thread.id === id),
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

test('Reader progress stays in the existing activity/typing UI and only Main delivery offers a payload receipt',async()=>{
  const ui=surface({thread:{conversationId:'reader-conversation'}});
  let seq=0;
  const event=(name,details={})=>ChatState.reduceChatEvent(ui.protocol,{type:'chat.event',v:2,event:name,
    streamId:'reader-stream',seq:++seq,engineId:'claude',conversationId:'reader-conversation',runId:'reader-run',
    clientThreadId:'ui',details},['claude']);
  event('run.started');
  const run=ui.protocol.runs[ChatState.runKey('reader-conversation','reader-run')];
  event('context.bound',{captures:[{sourceId:'immutable-source',snapshotId:'immutable-source',label:'Selected source'}]});
  event('reader.started',{sourceId:'immutable-source',readerSessionId:'native-reader',totalPartitions:3});
  event('reader.completed',{sourceId:'immutable-source',readerSessionId:'native-reader',reviewedPartitions:1,totalPartitions:3,
    text:'PRIVATE_READER_OUTPUT',complete:false});
  assert.deepEqual(ChatState.projectRunMessages([],run),[],'Reader summary is not a chat answer');
  ui.state.codex.activityThreadId=null;
  ui.render();assert.equal(ui.panel(),null,'activity record is not made always visible');
  const working=ui.workingRow(ChatState.agentWorkingView(run),{name:'Claude',runId:run.runId,
    onOpen:()=>{ui.state.codex.activityThreadId='ui';ui.render();}});
  assert.equal(working.querySelectorAll('.egd-codex-typing-dots').length,1);
  assert.match(working.textContent,/Agent 작업 중/);
  assert.doesNotMatch(working.textContent,/PRIVATE_READER_OUTPUT|Reader/);
  await nodes(working,'chat-agent-working-open')[0].fire('click');
  assert.equal(nodes(ui.panel(),'chat-context-activity').length,2);
  assert.match(ui.panel().textContent,/Reader 요청 범위 처리 완료/);
  assert.doesNotMatch(ui.panel().textContent,/PRIVATE_READER_OUTPUT|전체.*완료/);
  assert.equal(nodes(ui.panel(),'chat-subagents').length,0);
  assert.equal(nodes(ui.panel(),'chat-delivered-input-open').length,0,'Reader processing does not claim delivery to Main');
  event('context.read.failed',{sourceId:'immutable-source',code:'ABORTED'});
  ui.render();
  assert.match(ui.panel().textContent,/요청한 자료 읽기가 중단되었습니다/);
  event('reader.failed',{sourceId:'immutable-source',code:'ENGINE_CAPACITY_UNKNOWN'});
  ui.render();
  assert.match(ui.panel().textContent,/자료 읽기 용량을 확인하지 못했습니다/);
  assert.doesNotMatch(ui.panel().textContent,/전송하지 않았으며/,'an accepted Main run is not called an unsent draft');
  assert.equal(nodes(ui.panel(),'chat-delivered-input-open').length,0,'failed delivery creates no receipt button');
  event('context.read.completed',{sourceId:'immutable-source',packetId:'delivered-range',complete:false});
  ui.render();
  const receipts=nodes(ui.panel(),'chat-delivered-input-open');
  assert.equal(receipts.length,0,'a bare completion event without an accepted input and delivery receipt is not proof');
  assert.doesNotMatch(JSON.stringify(attributes(ui.panel())),/delivered-range/,'an unverified packet ID is not exposed in the DOM');
  assert.deepEqual(ChatState.projectRunMessages([],run),[]);
});

test('Reader stop is engine/profile scoped and waits for a terminal event instead of claiming cancellation',async()=>{
  let reply,signal;
  const run={conversationId:'stopping-reader',runId:'stop-run',clientThreadId:'ui',engineId:'claude',
    engineProfileId:'claude-default',status:'running',messages:[],activities:[],pendingApprovals:[],pendingUserInputs:[]};
  const ui=surface({run,thread:{conversationId:run.conversationId,engineProfileId:'claude-default'},fetchJson:async(path,options)=>{
    assert.equal(path,'/chat/interrupt');signal=options.signal;
    return new Promise(resolve=>{reply=()=>resolve({accepted:true,stopRequested:true});});
  }});
  const stopping=ui.interrupt();
  assert.equal(run.stopPending,true);
  assert.deepEqual(ui.effects.revoked,[[run.runId,'ui']]);
  assert.equal(ChatState.agentWorkingView(run).state,'stopping');
  ui.epochScope.reset('codex');ui.epochScope.reset('claude','different-slot');
  assert.equal(signal.aborted,false,'an unrelated engine or profile cannot settle this stop');
  reply();await stopping;
  assert.equal(run.status,'stopping');assert.equal(ChatState.isRunBusy(run),true);
  assert.equal(run.stopRequested,true);assert.equal(run.stopPending,false);
  assert.equal(await ui.interrupt(),false,'no duplicate stop request');
  ChatState.reduceChatEvent(ui.protocol,{type:'chat.event',v:2,event:'run.completed',streamId:'stop-stream',seq:1,
    engineId:'claude',conversationId:run.conversationId,runId:run.runId,clientThreadId:'ui',details:{status:'interrupted'}},['claude']);
  assert.equal(ChatState.isRunBusy(run),false);
  assert.equal(ChatState.agentWorkingView(run),null);
  assert.equal(ui.effects.requests.length,1);assert.equal(ui.effects.timers,0);
});

test('B2 real capture carries the selected conversation routing, not site identity or active-room defaults', async () => {
  const browser = { id:'site', kind:'browser', label:'Site', sourceRef:{viewId:'site-card', uri:'https://source.invalid/',
    profileId:'site-profile', accountId:'site-user@source.invalid'} };
  const ui = surface({realCapture:true, thread:{engineProfileId:'claude-default',clientBindingId:'recorded-wire',conversationId:'native-old'},
    captureChatInputs: async ([input]) => [InputContext.inputSnapshot(input, {text:'EXACT SOURCE',url:input.sourceRef.uri})],
    fetchJson: async (path, options) => path.startsWith('/context/capabilities?') ? b2Capability : captureReply(JSON.parse(options.body)) });
  ui.state.codex.activeThreadId = 'other-codex';
  ui.state.codex.threads.push({id:'other-codex',engineId:'codex',messages:[]});
  const references = await ui.captureInputs('ui', [browser]);
  const scope = {engineId:'claude',engineProfileId:'claude-default',clientThreadId:'recorded-wire',conversationId:'native-old'};
  const query = new URL(ui.effects.requests[0].path,'http://local').searchParams;
  for (const [key,value] of Object.entries(scope)) assert.equal(query.get(key),value);
  const body = ui.effects.requests[1].body;
  assert.deepEqual(Object.fromEntries(Object.keys(scope).map(key=>[key,body[key]])),scope);
  assert.equal(body.attachments[0].content.text,'EXACT SOURCE');
  assert.equal(body.expectedContextScope,b2Capability.expectedContextScope);
  assert.equal(body.ownerKey,undefined); assert.equal(body.epoch,undefined);
  assert.equal(references[0].localSource.sourceRef.accountId,'site-user@source.invalid');
  assert.deepEqual(references[0].contextScope,scope);
  assert.ok(Object.isFrozen(references[0]));
});

test('B2 capabilities are exact and fail closed before any source capture on old or mismatched bridges', async () => {
  for (const descriptor of [null,{...b2Capability,expectedContextScope:undefined},{...b2Capability,contract:'dynamicTools'}, {...b2Capability,engineId:'codex'},
    {...b2Capability,engineProfileId:'other'}, {...b2Capability,immutableRead:false}, {...b2Capability,nativeReader:true},
    {...b2Capability,nativeReader:'true'}, {...b2Capability,nativeReader:undefined},
    {...readerCapability,largeReader:false}, {...readerCapability,reader:undefined},
    {...readerCapability,reader:{...readerCapability.reader,ready:false}},
    {...readerCapability,reader:{...readerCapability.reader,engineId:'codex'}},
    {...readerCapability,reader:{...readerCapability.reader,code:'ENGINE_CAPACITY_UNKNOWN'}},
    {...readerCapability,expectedContextScope:undefined}, {...readerCapability,engineProfileId:'other'},
    {...b2Capability,tools:['egdesk_list_context']}, {...b2Capability,tools:'egdesk_list_context egdesk_read_source'},
    {...b2Capability,tools:[...b2Capability.tools,'egdesk_publish_briefing']}]) {
    const ui = surface({realCapture:true,fetchJson:async()=>descriptor});
    await assert.rejects(ui.captureInputs('ui',[fileInput()]),/현재 Claude 연결/);
    assert.equal(ui.effects.requests.length,1);
  }
  const ui = surface({realCapture:true,fetchJson:async()=>{throw Object.assign(new Error('old bridge'),{status:404});}});
  await assert.rejects(ui.captureInputs('ui',[fileInput()]),/현재 Claude 연결/);
  assert.equal(ui.effects.requests.length,1);
});

test('B2 real capture never accepts an incomplete batch, truncated source or another route receipt', async () => {
  for (const mutation of [reply=>({...reply,captures:[]}), reply=>({captures:[{...reply.captures[0],truncated:true}]}),
    reply=>({captures:[{...reply.captures[0],contextScope:{engineId:'codex',engineProfileId:'codex-default',clientThreadId:'ui'}}]})]) {
    const ui = surface({realCapture:true,fetchJson:async(path,options)=>path.startsWith('/context/capabilities?')
      ? b2Capability : mutation(captureReply(JSON.parse(options.body)))});
    await assert.rejects(ui.captureInputs('ui',[fileInput()]),/캡처|다른 엔진/);
    assert.equal(ui.effects.requests.length,2);
  }
});

test('same Claude slot with a changed email cancels real delayed capture, not an actual Codex send', async () => {
  let finishCapture, finishCodex;
  const browser={id:'browser-a',kind:'browser',label:'Site',sourceRef:{viewId:'card',uri:'https://source.invalid/'}};
  const ui=surface({realCapture:true,thread:{engineId:'codex'},captureChatInputs:([input])=>new Promise(resolve=>{
    finishCapture=()=>resolve([InputContext.inputSnapshot(input,{text:'ACCOUNT_A',url:input.sourceRef.uri})]);
  }),fetchJson:async(path,options)=>{
    if(path.startsWith('/context/capabilities?'))return b2Capability;
    if(path==='/chat/send')return new Promise(resolve=>{finishCodex=()=>resolve({accepted:true,
      requestId:JSON.parse(options.body).requestId,conversationId:'codex-kept',runId:'codex-run',engineId:'codex'});});
    assert.fail('late Claude capture POST');
  }});
  const claude={id:'claude-room',engineId:'claude',engineProfileId:'claude-default',messages:[],inputSources:[browser],preparingInput:true};
  ui.state.codex.threads.push(claude);
  ui.state.codex.threadDrafts[claude.id]='retain';
  const sending=ui.sendMessage();
  await new Promise(resolve=>setImmediate(resolve));
  const capturing=ui.captureInputs(claude.id,[browser]);
  const rejected=assert.rejects(capturing,/연결이 바뀌어/);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof finishCapture,'function');
  const next=clone(ui.state.codex.engines);
  next.find(row=>row.id==='claude').profiles[0].auth.account='new-engine-user@other.invalid';
  accountLifecycle(ui).update({engines:next});
  finishCapture(); await rejected;
  finishCodex(); await sending;
  assert.equal(Object.values(ui.protocol.requests)[0].status,'accepted');
  assert.equal(ui.state.codex.threadDrafts[claude.id],'retain');
  assert.deepEqual(claude.inputSources,[browser]);
  assert.equal(claude.preparingInput,false);
  assert.equal(ui.effects.requests.filter(row=>row.path==='/context/captures').length,0);
});

test('profile epoch invalidation also rejects finished tokens but preserves other Claude profiles and Codex',()=>{
  const scope=ChatState.createChatEpochScope();
  const old=scope.begin('claude','one'), finished=scope.begin('claude','one');scope.finish(finished);
  const legacy=scope.begin('claude');
  const other=scope.begin('claude','two'), codex=scope.begin('codex','codex-default');
  scope.reset('claude','one');
  assert.equal(old.signal.aborted,true);assert.equal(scope.valid(finished),false);
  assert.equal(scope.valid(legacy),false,'unscoped legacy run cannot retain an old account');
  assert.equal(scope.valid(other),true);assert.equal(scope.valid(codex),true);
  scope.reset('claude');assert.equal(scope.valid(other),false);assert.equal(scope.valid(codex),true);
});

test('immutable inspector uses recorded routing after UI restart/live change and rejects cross-engine/thread references',async()=>{
  const reference={sourceId:'fixed',snapshotId:'fixed',hash:'original-hash',contextScope:{engineId:'claude',engineProfileId:'claude-default',clientThreadId:'ui'}};
  const stored={capture:{sourceId:'fixed',hash:'original-hash',sourceRef:{},captureScope:{type:'file'}},
    source:{role:'source',hash:'original-hash',rangeHash:'range-v1',text:'ORIGINAL VERSION',mime:'text/plain',range:{startLine:1,endLine:1,totalLines:1}},delivered:null,bindings:[]};
  for(let restart=0;restart<2;restart++){
    const ui=surface({thread:{messages:[{inputReferences:[clone(reference)]}]},realCapture:true,
      fetchJson:async()=>clone(stored),captureChatInputs:async()=>assert.fail('must not recapture changed live source')});
    // subscribe normalizes real rooms; a dangling active ID would be repaired
    // back to ui instead of representing another room after Desk restoration.
    ui.state.codex.threads.push({id:'different',clientThreadId:'different',engineId:'claude',messages:[]});
    ui.state.codex.activeThreadId='different';
    const result=await ui.readInput(clone(reference),{threadId:'ui'});
    assert.equal(result.source.text,'ORIGINAL VERSION');assert.equal(result.source.rangeHash,'range-v1');
    const query=new URL(ui.effects.requests[0].path,'http://local').searchParams;
    assert.equal(query.get('clientThreadId'),'ui');assert.equal(query.get('engineId'),'claude');
    assert.equal(query.get('engineProfileId'),'claude-default');assert.equal(query.has('endLine'),false);
    for(const field of ['engineId','engineProfileId','clientThreadId']){
      const foreign=clone(reference);foreign.contextScope[field]='foreign';
      assert.equal(await ui.readInput(foreign,{threadId:'ui'}),null);
    }
    assert.equal(ui.effects.requests.length,1,'foreign references never reach HTTP');
  }
});

test('immutable inspector account/missing/manifest refusal never falls back to live recapture',async()=>{
  for(const code of ['ACCOUNT_CHANGED','CONTEXT_THREAD_MISMATCH','CONTEXT_TOOLS_UNAVAILABLE','SNAPSHOT_NOT_FOUND']){
    const ui=surface({fetchJson:async()=>{throw Object.assign(new Error(code),{code,status:409});}});
    assert.equal(await ui.readInput({sourceId:'fixed',hash:'h'},{threadId:'ui'}),undefined);
    assert.equal(ui.effects.requests.length,1);assert.deepEqual(ui.effects.capture,[]);
  }
});

test('production subscribe normalizes immediately, notifies through real lifecycle emits and isolates teardown per surface',()=>{
  const a=surface({thread:{participants:['self','self','peer']}}), b=surface();
  const seenA=[], seenB=[];
  const stopA=a.subscribe(value=>seenA.push({state:value,connected:value.connected}));
  const stopB=b.subscribe(value=>seenB.push(value));
  assert.equal(seenA.length,1);assert.equal(seenA[0].state,a.state.codex);
  assert.deepEqual(a.thread().participants,['self','peer'],'subscribe runs the production normalizer');
  assert.equal(a.thread().participantRoles.self,'owner');
  assert.equal(seenB.length,1);assert.equal(a.listenerCount(),1);assert.equal(b.listenerCount(),1);
  accountLifecycle(a).update({connected:false});
  assert.equal(seenA.at(-1).connected,false);assert.ok(seenA.length>1);
  assert.equal(seenB.length,1,'another surface does not receive this lifecycle notification');
  let throwOnNotify=false, afterThrow=0;
  const stopThrow=a.subscribe(()=>{if(throwOnNotify)throw new Error('fixture listener failure');});
  const stopAfter=a.subscribe(()=>afterThrow++);
  throwOnNotify=true;a.notify();
  assert.equal(afterThrow,2,'one failing listener must not swallow later subscribers');
  assert.ok(a.effects.logs.some(row=>Array.isArray(row)&&row.includes('codex listener failed')));
  stopThrow();stopAfter();
  assert.equal(stopA(),true);assert.equal(stopA(),false,'unsubscribe is idempotent');
  const countA=seenA.length;a.notify();b.notify();
  assert.equal(seenA.length,countA);assert.equal(seenB.length,2);
  stopB();assert.equal(a.listenerCount(),0);assert.equal(b.listenerCount(),0);
  assert.deepEqual(a.effects.requests,[]);assert.deepEqual(b.effects.requests,[]);
});

test('real readInput subscription survives unrelated notifications and is removed on success or request failure',async()=>{
  for(const outcome of ['success','failure']){
    const reference={sourceId:'fixed',hash:'original-hash',contextScope:{engineId:'claude',engineProfileId:'claude-default',clientThreadId:'ui'}};
    const stored={capture:{sourceId:'fixed',hash:'original-hash',sourceRef:{},captureScope:{type:'file'}},
      source:{role:'source',hash:'original-hash',rangeHash:'range-v1',text:'ORIGINAL VERSION',mime:'text/plain',range:{startLine:1,endLine:1,totalLines:1}},delivered:null,bindings:[]};
    let resolveRead,rejectRead,signal;
    const ui=surface({fetchJson:(_path,options)=>{signal=options.signal;return new Promise((resolve,reject)=>{resolveRead=resolve;rejectRead=reject;});}});
    const pending=ui.readInput(reference,{threadId:'ui'});
    assert.equal(ui.listenerCount(),1);assert.equal(signal.aborted,false);
    ui.notify();assert.equal(signal.aborted,false,'unchanged routing keeps the real read active');
    if(outcome==='success')resolveRead(stored);else rejectRead(new Error('explicit fixture read failure'));
    const result=await pending;
    if(outcome==='success')assert.equal(result.source.text,'ORIGINAL VERSION');
    else {assert.equal(result,undefined);assert.ok(ui.effects.logs.some(row=>typeof row==='string'&&row.includes('explicit fixture read failure')));}
    assert.equal(ui.listenerCount(),0,'readInput finally removes its actual subscription');
    ui.thread().clientBindingId='after-completion';ui.notify();
    assert.equal(signal.aborted,false,'a finished read no longer receives state notifications');
    assert.equal(ui.effects.requests.length,1);assert.deepEqual(ui.effects.capture,[]);
  }
});

test('real notification aborts a rebound read before late transport settlement without cancelling another surface',async()=>{
  for(const outcome of ['resolve','reject']){
    const reference={sourceId:'fixed',hash:'original-hash',contextScope:{engineId:'claude',engineProfileId:'claude-default',clientThreadId:'ui'}};
    const stored={capture:{sourceId:'fixed',hash:'original-hash',sourceRef:{},captureScope:{type:'file'}},
      source:{role:'source',hash:'original-hash',rangeHash:'range-v1',text:'ORIGINAL VERSION',mime:'text/plain',range:{startLine:1,endLine:1,totalLines:1}},delivered:null,bindings:[]};
    const pendingSurface=()=>{
      let resolveRead,rejectRead,signal;
      const ui=surface({fetchJson:(_path,options)=>{signal=options.signal;return new Promise((resolve,reject)=>{resolveRead=resolve;rejectRead=reject;});}});
      const pending=ui.readInput(clone(reference),{threadId:'ui'});
      return {ui,pending,signal,resolveRead,rejectRead};
    };
    const a=pendingSurface(), b=pendingSurface();
    assert.equal(a.ui.listenerCount(),1);assert.equal(b.ui.listenerCount(),1);
    a.ui.thread().clientBindingId='rebound';a.ui.notify();
    assert.equal(a.signal.aborted,true,'notification must abort before the ignored-abort transport resolves');
    assert.equal(b.signal.aborted,false,'subscription storage belongs to each surface');
    if(outcome==='resolve')a.resolveRead(stored);else a.rejectRead(new Error('late obsolete failure'));
    assert.equal(await a.pending,undefined);
    assert.equal(a.ui.listenerCount(),0);assert.deepEqual(a.ui.effects.logs,[]);
    b.resolveRead(stored);assert.equal((await b.pending).source.text,'ORIGINAL VERSION');
    assert.equal(b.ui.listenerCount(),0);
    for(const {ui} of [a,b]){assert.equal(ui.effects.requests.length,1);assert.deepEqual(ui.effects.capture,[]);}
  }
});

test('Claude attachment send uses server-confirmed Reader capability without granting Browser or publication tools',async()=>{
  for(const capability of [b2Capability,{...b2Capability,largeReader:false,
    reader:{ready:false,engineId:'claude',code:'ENGINE_CAPACITY_UNKNOWN'}},readerCapability]){
  let finishSend;
  const selected={id:'site',kind:'browser',label:'Site',selectedByUser:true,browserToolPermission:'observe',
    sourceRef:{viewId:'card',uri:'https://site.invalid/',profileId:'site-slot',accountId:'site@other.invalid'}};
  const ui=surface({realCapture:true,thread:{inputSources:[selected]},
    captureChatInputs:async([input])=>[InputContext.inputSnapshot(input,{text:'EXACT',url:input.sourceRef.uri})],
    fetchJson:async(path,options)=>{
      if(path.startsWith('/context/capabilities?'))return capability;
      if(path==='/context/captures')return captureReply(JSON.parse(options.body));
      assert.equal(path,'/chat/send');
      return new Promise(resolve=>{finishSend=()=>resolve({accepted:true,requestId:JSON.parse(options.body).requestId,
        conversationId:'bound',runId:'accepted',engineId:'claude'});});
    }});
  const sending=ui.sendMessage();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(ui.state.codex.threadDrafts.ui,'  keep my draft  ');
  assert.deepEqual(ui.thread().inputSources,[selected]);
  const request=ui.effects.requests.at(-1).body;
  assert.deepEqual(request.contextSnapshotIds,['stored-site']);
  assert.deepEqual(request.contextCapabilities,{read:true,reader:capability.nativeReader,publishBriefing:false});
  assert.equal(request.engineId,'claude');assert.equal(request.engineProfileId,'claude-default');
  assert.equal(request.expectedContextScope,b2Capability.expectedContextScope);
  assert.equal(request.expectedContextScope,ui.effects.requests.find(row=>row.path==='/context/captures').body.expectedContextScope);
  assert.equal(JSON.stringify(ui.thread()).includes('expectedContextScope'),false,'operation expectation is not persisted in a thread or capture reference');
  assert.equal(JSON.stringify(ui.thread()).includes('claudeContextCapabilities'),false,'readiness is request-local, never saved as authority');
  const attachment=ui.effects.requests.find(row=>row.path==='/context/captures').body.attachments[0];
  assert.equal(attachment.sourceRef.browserProfileId,'site-slot');
  assert.equal(attachment.sourceRef.siteAccount,'site@other.invalid','source-site identity never has to match the engine account');
  for(const field of ['ownerKey','epoch','selectedSources','executionPolicy','contextResolution'])assert.equal(request[field],undefined);
  finishSend();await sending;
  assert.equal(ui.state.codex.threadDrafts.ui,'');assert.deepEqual(ui.thread().inputSources,[]);
  assert.equal(ui.thread().engineProfileId,'claude-default');
  }
});

test('actual engine switch after definite Claude Reader refusal recaptures selected sources under Codex, never relabels old captures',async()=>{
  const selected=fileInput('large-context'), receipts=[], sends=[];
  const ui=surface({realCapture:true,thread:{inputSources:[selected]},fetchJson:async(path,options)=>{
    if(path.startsWith('/context/capabilities?'))return b2Capability;
    const body=JSON.parse(options.body);
    if(path==='/context/captures'){
      const expected=body.engineId==='claude'?'claude-default':'codex-selected-slot';
      if(body.engineProfileId!==expected)throw Object.assign(new Error('Wrong engine profile'),{code:'ENGINE_PROFILE_MISMATCH',status:403});
      const capture={...captureReply(body).captures[0],sourceId:`${body.engineId}-immutable`,snapshotId:`${body.engineId}-immutable`,
        engine:{engineId:body.engineId,engineProfileId:body.engineProfileId}};
      receipts.push(clone(capture));return{captures:[capture]};
    }
    assert.equal(path,'/chat/send');sends.push(body);
    if(body.engineId==='claude')throw Object.assign(new Error('Reader required'),{code:'CLAUDE_CONTEXT_READER_UNSUPPORTED',status:409,accepted:false});
    return{accepted:true,requestId:body.requestId,conversationId:'new-codex',runId:'codex-run',engineId:'codex'};
  }});
  ui.state.codex.engines[0].profiles=[{id:'codex-selected-slot',active:true,auth:{status:'signedIn'}}];
  await ui.sendMessage();
  assert.equal(ui.thread().engineProfileId,'claude-default');
  assert.equal(ChatState.chatThreadEngineLocked(ui.thread()),false);
  assert.match(ui.thread().sendError,/Smart Read/);
  assert.deepEqual(ui.thread().messages,[]);
  const oldReceipt=clone(receipts[0]);
  const retained=clone({draft:ui.state.codex.threadDrafts.ui,inputs:ui.thread().inputSources,briefings:ui.thread().briefingInputs});
  ui.setThreadEngine('ui','codex');
  assert.deepEqual({draft:ui.state.codex.threadDrafts.ui,inputs:ui.thread().inputSources,briefings:ui.thread().briefingInputs},retained);
  assert.equal(ChatState.chatThreadEngineProfileId(ui.thread(),ui.state.codex),'codex-selected-slot');
  await ui.sendMessage();
  assert.equal(receipts.length,2,'a fresh capture is made under the selected Codex authority');
  assert.deepEqual(receipts[0],oldReceipt,'the Claude snapshot is never relabeled');
  assert.deepEqual(sends.map(body=>body.contextSnapshotIds),[['claude-immutable'],['codex-immutable']]);
  assert.equal(sends[1].expectedContextScope,undefined,'Claude expectation is not reused by Codex');
  assert.deepEqual(ui.effects.requests.filter(row=>row.path==='/context/captures').map(row=>[row.body.engineId,row.body.engineProfileId]),
    [['claude','claude-default'],['codex','codex-selected-slot']]);
  assert.equal(ui.state.codex.threadDrafts.ui,'');
  assert.equal(ui.effects.synced.at(-1).engineId,'codex');
});

test('actual engine selection keeps a same-engine slot and cannot reset a locked conversation profile',()=>{
  const ui=surface({thread:{engineProfileId:'claude-default',inputSources:[fileInput()]}});
  const before=clone(ui.thread());
  ui.setThreadEngine('ui','claude');assert.deepEqual(ui.thread(),before);
  ui.thread().conversationId='bound';
  const locked=clone(ui.thread());
  ui.setThreadEngine('ui','codex');assert.deepEqual(ui.thread(),locked);
  ui.thread().conversationId=null;
  ui.thread().messages=[{role:'user',content:'accepted'}];
  const accepted=clone(ui.thread());
  ui.setThreadEngine('ui','codex');assert.deepEqual(ui.thread(),accepted);
});

test('switching an unbound room never relabels or submits an already immutable foreign-engine reference',async()=>{
  const reference={sourceId:'claude-fixed',snapshotId:'claude-fixed',hash:'h',
    contextScope:{engineId:'claude',engineProfileId:'claude-default',clientThreadId:'ui'}};
  const ui=surface({realCapture:true,thread:{engineProfileId:'claude-default',briefingInputs:[reference]}});
  ui.setThreadEngine('ui','codex');
  await ui.sendMessage();
  assert.deepEqual(ui.thread().briefingInputs,[reference]);
  assert.equal(ui.state.codex.threadDrafts.ui,'  keep my draft  ');
  assert.deepEqual(ui.thread().messages,[]);assert.deepEqual(ui.effects.requests,[]);
  assert.match(ui.thread().sendError,/다른 엔진 또는 대화/);
});

test('Claude capture and send failures preserve exact draft and all attachments with no retry or provider fallback',async()=>{
  for(const phase of ['capture','send'])for(const code of ['CONTEXT_CAPTURE_INCOMPLETE','UNSUPPORTED_SOURCE_FORMAT',
    'CLAUDE_CONTEXT_READER_UNSUPPORTED','CONTEXT_THREAD_MISMATCH','CONTEXT_TOOLS_UNAVAILABLE','CONTEXT_SCOPE_CHANGED',
    'ENGINE_CAPACITY_UNKNOWN','CONTEXT_CAPACITY_REQUIRED','ENGINE_CONTEXT_CONFIGURATION_ERROR','PACKET_ADMISSION_REQUIRED',
    'READER_UNAVAILABLE','READER_ISOLATION_UNAVAILABLE','READER_FAILED','READER_RECEIPT_INVALID','ABORTED','READ_CANCELLED','ACCOUNT_CHANGED','NETWORK']){
    const inputs=[fileInput('one'),fileInput('two')];
    const ui=surface({realCapture:true,thread:{inputSources:inputs},fetchJson:async(path,options)=>{
      if(path.startsWith('/context/capabilities?'))return b2Capability;
      if(phase==='send'&&path==='/context/captures')return captureReply(JSON.parse(options.body));
      throw Object.assign(new Error(code),{code,...(code==='NETWORK'?{}:{status:409,accepted:false})});
    }});
    await ui.sendMessage();
    assert.equal(ui.state.codex.threadDrafts.ui,'  keep my draft  ');
    assert.deepEqual(ui.thread().inputSources,inputs);
    assert.equal(ui.thread().engineId,'claude');assert.equal(ui.effects.timers,0);
    assert.equal(ui.effects.requests.length,phase==='capture'?2:3);
    if(phase==='capture'||ChatState.claudeContextSendErrorText(code))assert.deepEqual(ui.thread().messages,[]);
    if(code==='CLAUDE_CONTEXT_READER_UNSUPPORTED')assert.match(ui.thread().sendError,/Smart Read.*지원하지 않아/);
    assert.equal(ui.thread().preparingInput,false);
  }
});

test('Claude Reader diagnostics use bounded user copy and distinguish an accepted run from an unsent draft',()=>{
  for(const code of ['ENGINE_CAPACITY_UNKNOWN','ENGINE_CONTEXT_CONFIGURATION_ERROR','CONTEXT_CAPACITY_REQUIRED',
    'PACKET_ADMISSION_REQUIRED','READER_UNAVAILABLE','READER_ISOLATION_UNAVAILABLE','READER_RECEIPT_INVALID','READER_FAILED','READ_CANCELLED',
    'READER_CONFIGURATION_REQUIRED','READER_CONFIGURATION_MISMATCH','READER_BUSY','READER_SESSION_LIMIT','READER_STOP_PENDING',
    'READER_OFFLINE','READER_TIMEOUT','READER_INPUT_INVALID','READER_SESSION_MISMATCH','READER_SCOPE_VIOLATION','READER_PROTOCOL_ERROR',
    'READER_INVALID_PACKET','READER_INVALID_CITATION','READER_EVENT_LIMIT','READER_OUTPUT_LIMIT'])for(const origin of ['claude','egdesk']){
    const error={code,origin,kind:'unknown',message:'PRIVATE_READER_DETAILS'};
    const notice=ChatState.runErrorNotice(error);
    assert.equal(notice.text,ChatState.claudeContextReadErrorText(code));
    assert.equal(notice.action,null);
    assert.doesNotMatch(notice.text,/PRIVATE_READER_DETAILS|전송하지|초안/);
    assert.match(ChatState.claudeContextSendErrorText(code),/전송하지 않았으며 초안과 선택 자료는 유지됩니다/);
  }
  assert.equal(ChatState.claudeContextReadErrorText('UNKNOWN_READER_INTERNAL'),null);
  assert.equal(ChatState.claudeContextSendErrorText('READER_UNAVAILABLE','codex'),null);
});

test('real Browser capture pins site profile/container independently of engine login and refuses source changes',async()=>{
  const selected={id:'source',kind:'browser',label:'Site',sourceRef:{viewId:'card',uri:'https://site.invalid/',profileId:'site-slot',accountId:'site@other.invalid'},
    browserToolIdentity:{cardEpoch:'card-one',userContextId:4,engineAccountKey:'old-codex-key',authorityEpoch:0}};
  for(const changed of [null,'profileId','accountId','cardEpoch','userContextId']){
    let resolve;
    const binding={profileId:'site-slot',accountId:'site@other.invalid',cardEpoch:'card-one',userContextId:4,
      engineAccountKey:'a-different-engine-key',authorityEpoch:99};
    const card={isConnected:true,_browserControls:{toolBinding:()=>binding,captureInput:()=>new Promise(done=>{resolve=done;})}};
    const capture=compile(`${functionSource('captureChatInputs')}\nreturn captureChatInputs;`,{
      InputContext,document:{getElementById:()=>card},persistentEntityGeometry:()=>({x:0,y:0}),chatBindingNonce:()=> 'fixed',
    });
    const pending=capture([selected]);
    if(changed)binding[changed]='changed';
    resolve({text:'exact',url:selected.sourceRef.uri});
    if(changed)await assert.rejects(pending,/자료 계정이나 창이 바뀌었습니다/);
    else assert.equal((await pending)[0].content.text,'exact');
  }
});

test('server-recorded engine profile survives real snapshot normalization and cannot silently switch slots',()=>{
  const state=ChatState.createChatProtocolState();
  const [run]=ChatState.mergeChatSnapshot(state,{conversationId:'c',runs:[{runId:'r',engine:{id:'claude',engineProfileId:'old-slot'},status:'completed',messages:[]}]},'ui');
  assert.equal(run.engineProfileId,'old-slot');
  assert.equal(ChatState.chatThreadEngineProfileId({id:'ui',engineId:'claude',engineProfileId:run.engineProfileId},{engines:[claudeRow()]}),'old-slot');
  assert.equal(ChatState.chatThreadReadiness({engineId:'claude',engineProfileId:run.engineProfileId},{engines:[claudeRow()]}).ready,false);
  assert.deepEqual(ChatState.mergeChatSnapshot(state,{conversationId:'c',runs:[{runId:'r',engine:{id:'claude',engineProfileId:'new-slot'},messages:[]}]},'ui'),[]);
  assert.equal(run.engineProfileId,'old-slot');
});

test('unbound Claude chat rejects A capture intent under B before delayed SSE, using real HTTP, authority and immutable store',async t=>{
  const h=await runtime(t,{store:true,initialSend:false});
  const dir=mkdtempSync(join(tmpdir(),'egdesk-ui-scope-race-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new ImmutableContextStore({dataDir:dir,allowedRoots:[dir]});
  const contexts=new ContextRuntime({store,getAuthority:hints=>h.chat.contextAuthority(hints),schemaReady:()=>true});
  contexts.runtime=h.chat;
  const handler=createContextHttpHandler(contexts,async hints=>{h.chat.contextAuthority(hints);});
  let releaseCapture;
  const selected={id:'old-intent',kind:'browser',label:'Source',sourceRef:{viewId:'card',uri:'https://site.invalid/',
    profileId:'site-profile',accountId:'different-site-account@site.invalid'}};
  const ui=surface({realCapture:true,thread:{inputSources:[selected]},
    captureChatInputs:([input])=>new Promise(resolve=>{releaseCapture=()=>resolve([InputContext.inputSnapshot(input,{text:'A_SELECTED_BYTES',url:input.sourceRef.uri})]);}),
    fetchJson:async(path,options={})=>{
      assert.notEqual(path,'/chat/send','stale intent must be refused before native send');
      const req=Readable.from(options.body?[Buffer.from(options.body)]:[]);
      req.method=options.method||'GET';req.headers={host:'localhost:39218','content-type':'application/json'};
      const res={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
      await handler(req,res,new URL(path,'http://localhost'));
      if(res.status>=400)throw Object.assign(new Error(res.body.error),{code:res.body.code,status:res.status,accepted:false});
      return res.body;
    }});
  const uiIdentity=clone(ui.state.codex.engines);
  assert.equal(h.chat.store.getConversation('ui'),null,'client has no bound native conversation');
  const sending=ui.sendMessage();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(typeof releaseCapture,'function','capability A was read before delayed Browser capture');
  h.changeAccount('account-b@example.invalid');
  releaseCapture();await sending;
  assert.deepEqual(ui.state.codex.engines,uiIdentity,'no SSE/account update reached the UI');
  assert.equal(ui.state.codex.threadDrafts.ui,'  keep my draft  ');
  assert.deepEqual(ui.thread().inputSources,[selected]);
  const authorityB=h.chat.contextAuthority({engineId:'claude',engineProfileId:'claude-default',clientThreadId:'ui'});
  assert.deepEqual(await store.listRecords(contexts.owner(authorityB),'sources'),[],'no account-A bytes persisted under B');
  assert.deepEqual(ui.thread().messages,[]);
  assert.equal(ui.effects.requests.filter(row=>row.path==='/chat/send').length,0);
  assert.equal(ui.effects.requests.length,2,'one capability then one refused capture; never refresh/retry as B');
  assert.match(ui.effects.requests[1].body.expectedContextScope,/^[a-f0-9]{64}$/);
  assert.match(ui.thread().sendError,/Claude.*계정|연결.*바뀌/);
  assert.equal(h.transports.length,0);assert.deepEqual(h.codexCalls,[]);
});

// Synthetic capacity evidence exercises the positive contract, not the installed
// Claude provider's readiness. Actual authority, planning, storage, HTTP and UI
// functions run; a Reader or live native process must never run during preflight.
async function contextSurface(t,{contents=['complete small source'],capacityKnown=true,readerReady=true,beforeSend,beforeRead,allowDelivery=false}={}){
  const dir=mkdtempSync(join(tmpdir(),'egdesk-ui-reader-'));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new ImmutableContextStore({dataDir:dir,allowedRoots:[dir]});
  const plans=[],replies=[];
  const selection={model:'claude-sonnet-4-6',effort:'medium',revision:'synthetic-selection-v1'};
  const engineBuild='2.1.300';
  const metadataHash=hashContent('synthetic UI preflight capacity evidence; not production readiness');
  let h;
  const contexts=new ContextRuntime({store,getAuthority:hints=>h.chat.contextAuthority(hints),schemaReady:()=>true,
    reader:{read:async()=>assert.fail('Claude must never fall back to Codex Reader'),disconnect(){}},
    readers:{claude:{estimateInput:estimateClaudeReaderInput,readiness:({authority,model,effort})=>{
      assert.equal(authority.engineId,'claude');
      assert.equal(authority.engineProfileId,'claude-default');
      assert.equal(model,selection.model,'Context resolves the server-selected Reader model');
      assert.equal(effort,selection.effort,'Context resolves the server-selected Reader effort');
      return{ready:readerReady,code:readerReady?null:'READER_ISOLATION_UNAVAILABLE'};
    },
      read:async()=>assert.fail('preflight must not execute Reader'),disconnect(){}}},
    getReadCapacity:({authority})=>capacityKnown?{capacity:{status:'verified',engineId:'claude',fallback:false,source:'native-observation',
      model:selection.model,engineBuild,metadataHash,
      scope:{...authority},modelSelectionRevision:selection.revision,observedAt:Date.now(),
      usableContextWindow:64000,toolOutputLimitTokens:8192,inputOverheadTokens:256,
      estimator:{kind:'utf8-upper-bound',verified:true,version:'synthetic-test-v1'}},
      selection:{...selection},engineBuild,
      usage:{usedTokens:512},readerBudget:{maxInputTokens:4000,inputOverheadTokens:256}}:{},
  });
  const actualRead=contexts.smartRead.read.bind(contexts.smartRead);
  contexts.smartRead.read=async options=>{
    assert.ok(options.prepareOnly || allowDelivery,'this UI admission test never executes a Reader');
    const result=await actualRead(options);
    plans.push(result.plan||{mode:result.packet.mode});return result;
  };
  h=await runtime(t,{store:true,initialSend:false,contexts});
  const auth=createChatEngineAuth({chat:h.chat,refreshCodexAccount:async()=>assert.fail('Claude must not authenticate Codex'),
    getCodexAuth:()=>({isLoggedIn:false})});
  const contextHandler=createContextHttpHandler(contexts,async hints=>{h.chat.contextAuthority(hints);});
  const chatHandler=createChatHttpHandler(h.chat,auth);
  const fetchJson=compile(`${between('    const fetchJson = async','\n\n    // One catalog read')}\nreturn fetchJson;`,{BoardThread,
    fetch:async(url,options={})=>{
      const path=new URL(url).pathname;
      if(path==='/chat/send')await beforeSend?.(h,contexts);
      if(path.startsWith('/context/captures/') && (!options.method || options.method==='GET')) {
        await beforeRead?.(url,options);
        if(options.signal?.aborted)throw Object.assign(new Error('aborted'),{name:'AbortError'});
      }
      const req=Readable.from(options.body?[Buffer.from(options.body)]:[]);
      Object.assign(req,{method:options.method||'GET',url,headers:{host:'127.0.0.1:39218','content-type':'application/json'},
        socket:{remoteAddress:'127.0.0.1'}});
      const res={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
      if(!await contextHandler(req,res,new URL(url)))assert.equal(await chatHandler(req,res,new URL(url)),true);
      replies.push({path,status:res.status,body:res.body});
      return{ok:res.status<400,status:res.status,text:async()=>JSON.stringify(res.body),json:async()=>res.body};
    },
  });
  const selected=contents.map((_,index)=>({id:`selected-${index}`,kind:'browser',label:`Source ${index}`,
    sourceRef:{viewId:`card-${index}`,uri:`https://source.invalid/${index}`,profileId:'site-profile',accountId:'different-site-user@source.invalid'}}));
  const ui=surface({realCapture:true,realProjection:true,auth:{isLoggedIn:false},thread:{inputSources:selected},fetchJson,
    captureChatInputs:async([input])=>[InputContext.inputSnapshot(input,{text:contents[selected.findIndex(row=>row.id===input.id)],url:input.sourceRef.uri})]});
  ui.state.codex.connected=false;ui.state.codex.engines[0].status='offline';
  ui.subscribe(()=>{})(); // The live bridge normalizes its initial threads before a user can send.
  return{ui,h,contexts,store,plans,replies,selected};
}

async function deliveredClaudeFixture(t,options={}) {
  const {ui,h,contexts,store,replies,selected}=await contextSurface(t,{contents:['SYNTHETIC_SOURCE'],capacityKnown:true,allowDelivery:true,...options});
  await ui.sendMessage();
  const capture=replies.find(row=>row.path==='/context/captures').body.captures[0];
  const run=[...h.chat.runs.values()][0];
  assert.ok(run && capture.sourceId);
  const request={subtype:'mcp_message',server_name:'egdesk',message:{jsonrpc:'2.0',id:1,method:'tools/call',
    params:{name:'egdesk_read_source',arguments:{snapshotId:capture.sourceId,intent:'Read the selected immutable source'}}}};
  h.transports[0].options.controlHandlers.mcp_message(request,{requestId:'proof-read'});
  await h.drain(); await Promise.all([...contexts.calls.values()]); await h.drain();
  const packet=run.context.packets[0];
  assert.ok(packet?.receiptId,`the real local context runtime issued a delivery receipt: ${JSON.stringify({replies:h.transports[0].replies,events:h.events.filter(e=>e.event?.startsWith('context.read'))})}`);
  const authority=h.chat.contextAuthority({engineId:'claude',engineProfileId:'claude-default',clientThreadId:'ui'});
  const receipt=await store.getRecord(contexts.owner(authority),'deliveries',packet.receiptId);
  assert.equal(receipt.deliveryStatus,'sent-to-app-server');
  assert.equal(receipt.packetId,packet.packetId);
  assert.deepEqual([receipt.binding.conversationId,receipt.binding.runId,receipt.binding.answerId],
    [run.conversationId,run.runId,run.answerId]);
  const origin={engineId:'claude',engineProfileId:'claude-default',clientThreadId:'ui'};
  const reference=InputContext.capturedInputReference(selected[0],capture,origin);
  // Project the actual runtime's events and a synthetic assistant message for
  // this same run. The receipt/capture/packet come from the real local store.
  h.chat.emit(run,'message.started',{messageId:'synthetic-assistant',text:'synthetic answer'},'synthetic-assistant');
  for(const event of h.events) ChatState.reduceChatEvent(ui.protocol,event,['codex','claude']);
  const thread=ui.thread();
  const identity={conversationId:run.conversationId,runId:run.runId,answerId:run.answerId};
  const displayed=ui.protocol.runs[ChatState.runKey(run.conversationId,run.runId)];
  assert.ok(displayed); thread.messages=ChatState.projectRunMessages(thread.messages,displayed);
  const answer=thread.messages.find(row=>row.role==='assistant');
  const accepted=ui.inputReceipt(thread,identity);
  assert.ok(accepted,'the actual durable send supplies the same-run user receipt');
  assert.equal(ui.visibleAnswer(thread,reference,identity),answer);
  assert.equal(ui.deliveryProof('ui',reference,identity,null,packet.packetId)?.receiptId,packet.receiptId);
  assert.equal(ui.deliveryProof('ui',{...reference,sourceId:'other-source'},identity,null,packet.packetId),null,
    'a receipt for another source never authorizes this packet');
  return {ui,h,run,displayed,reference,identity,packet};
}

test('Claude delivered packet with a real local receipt remains visible only for its own source', async t => {
  const {ui,run}=await deliveredClaudeFixture(t);
  ui.state.codex.activityThreadId='ui'; ui.render();
  const buttons=nodes(ui.panel(),'chat-delivered-input-open');
  assert.equal(buttons.length,1,
    'a same-run server-issued Claude delivery remains discoverable without a Codex login');
  assert.equal(buttons[0].dataset.packetId,undefined,'the unverified packet ID is not placed on the button');
  await buttons[0].fire('click');
  const panel=ui.document.getElementById('egd-codex-input-panel');
  assert.ok(panel,`the production inspector opened the local source: ${JSON.stringify(ui.effects.logs)}`);
  assert.equal(nodes(panel,'chat-input-delivery').length,1,'the exact stored delivery survived the production proof and hash checks');
  assert.match(panel.textContent,/SYNTHETIC_SOURCE/);
  const reads=ui.effects.requests.filter(row=>row.path.startsWith('/context/captures/'));
  assert.equal(reads.length,2,'the inspector performs the scoped source read and exact packet read');
  assert.ok(reads.every(row=>row.path.includes('engineId=claude') && row.path.includes('engineProfileId=claude-default')
    && row.path.includes(`conversationId=${encodeURIComponent(run.conversationId)}`)));
});

test('Claude delivery refuses foreign account, profile, room, answer, source, hash and receipt without fetching',async t=>{
  for(const kind of ['account','profile','room','answer','run','source','source hash','packet hash','delivery receipt','user receipt']) await t.test(kind,async t=>{
    const {ui,displayed}=await deliveredClaudeFixture(t);
    ui.state.codex.activityThreadId='ui';ui.render();
    const originalButton=nodes(ui.panel(),'chat-delivered-input-open')[0];assert.ok(originalButton);
    const answer=ui.thread().messages.find(row=>row.role==='assistant');
    const completed=answer.contextEvents.find(row=>row.event==='context.read.completed').details;
    const request=ui.protocol.requests[displayed.requestId], profile=ui.state.codex.engines[1].profiles[0];
    const marker=`FOREIGN_${kind.replaceAll(' ','_').toUpperCase()}`;
    let restore;
    if(kind==='account') { const old=profile.auth.account;profile.auth.account=marker;restore=()=>{profile.auth.account=old;}; }
    else if(kind==='profile') { const old=ui.thread().engineProfileId;ui.thread().engineProfileId=marker;restore=()=>{ui.thread().engineProfileId=old;}; }
    else if(kind==='room') {
      ui.state.codex.threads.push({id:marker,clientThreadId:marker,engineId:'claude',messages:[],inputSources:[],briefingInputs:[]});
      ui.state.codex.activeThreadId=marker;ui.state.codex.activityRoomGeneration=(ui.state.codex.activityRoomGeneration||0)+1;
      restore=()=>{ui.state.codex.activeThreadId='ui';ui.state.codex.threads=ui.state.codex.threads.filter(row=>row.id!==marker);};
    } else {
      const target=kind==='answer'||kind==='run'?answer:kind==='source'||kind==='source hash'?answer.contextCaptures[0]
        :kind==='user receipt'?request:completed;
      const key=({answer:'answerId',run:'runId',source:'sourceId','source hash':'hash','packet hash':'hash',
        'delivery receipt':'receiptId','user receipt':'acceptedInputMessageId'})[kind];
      const old=target[key];target[key]=marker;restore=()=>{target[key]=old;};
    }
    const before=ui.effects.requests.length;
    ui.notify();ui.render();
    assert.equal(nodes(ui.panel(),'chat-delivered-input-open').length,0,`${kind}: no receipt control`);
    await originalButton.fire('click');
    assert.equal(ui.effects.requests.length,before,`${kind}: the stale control makes no unauthorized request`);
    assert.equal(ui.document.getElementById('egd-codex-input-panel'),null);
    assert.doesNotMatch(JSON.stringify(attributes(ui.root))+ui.root.textContent,new RegExp(marker));
    assert.equal(JSON.stringify(ui.state).includes('SYNTHETIC_SOURCE'),false,`${kind}: source payload was not copied into state`);
    restore();ui.notify();
    assert.equal(JSON.stringify(ui.state).includes(marker),false,`${kind}: foreign identifier was not retained`);
  });
});

test('delayed Claude delivery read cannot revive after an account or room round trip',async t=>{
  for(const kind of ['account','room']) await t.test(kind,async t=>{
    let release,entered;
    const gate=new Promise(resolve=>{release=resolve;});
    const waiting=new Promise(resolve=>{entered=resolve;});
    const {ui}=await deliveredClaudeFixture(t,{beforeRead:async()=>{entered();await gate;}});
    ui.state.codex.activityThreadId='ui';ui.render();
    const button=nodes(ui.panel(),'chat-delivered-input-open')[0];assert.ok(button);
    const opening=button.fire('click');await waiting;
    const profile=ui.state.codex.engines[1].profiles[0],account=profile.auth.account;
    if(kind==='account') profile.auth.account='FOREIGN_ASYNC_ACCOUNT';
    else {
      ui.state.codex.threads.push({id:'foreign-async-room',engineId:'claude',messages:[],inputSources:[],briefingInputs:[]});
      ui.state.codex.activeThreadId='foreign-async-room';ui.state.codex.activityRoomGeneration=(ui.state.codex.activityRoomGeneration||0)+1;
    }
    ui.notify();
    if(kind==='account') profile.auth.account=account;
    else {ui.state.codex.activeThreadId='ui';ui.state.codex.activityRoomGeneration++;}
    ui.notify();release();await opening;
    assert.equal(ui.document.getElementById('egd-codex-input-panel'),null);
    assert.equal(ui.effects.requests.filter(row=>row.path.startsWith('/context/captures/')).length,1,'an invalidated first read cannot trigger the packet read');
    assert.doesNotMatch(ui.root.textContent,/SYNTHETIC_SOURCE|FOREIGN_ASYNC_ACCOUNT|foreign-async-room/);
    assert.equal(JSON.stringify(ui.state.codex.chatProtocol).includes('SYNTHETIC_SOURCE'),false);
  });
});

test('Claude receipt fence survives hash verification and the read-to-panel handoff',async t=>{
  for(const phase of ['hash','post-read']) for(const kind of ['account','room']) await t.test(`${phase}: ${kind} round trip`,async t=>{
    let release,entered;
    const gate=new Promise(resolve=>{release=resolve;});
    const waiting=new Promise(resolve=>{entered=resolve;});
    const {ui,packet}=await deliveredClaudeFixture(t);
    if(phase==='hash') ui.window.crypto={subtle:{digest:async(...args)=>{entered();await gate;return webcrypto.subtle.digest(...args);}}};
    else {
      const realRead=ui.readInput;
      ui.state.codexBridge.readInput=async function(...args) {
        const result=await realRead.apply(this,args);
        assert.ok(result?.delivered,'the real scoped source and packet reads and hash verification have completed');
        entered();await gate;return result;
      };
    }
    ui.state.codex.activityThreadId='ui';ui.render();
    const opening=nodes(ui.panel(),'chat-delivered-input-open')[0].fire('click');
    await waiting;
    assert.equal(ui.effects.requests.filter(row=>row.path.startsWith('/context/captures/')).length,2,
      'the source and exact packet reads have both reached the real local HTTP handler');
    const profile=ui.state.codex.engines[1].profiles[0],account=profile.auth.account;
    if(kind==='account') profile.auth.account='FOREIGN_GAP_ACCOUNT';
    else {
      ui.state.codex.threads.push({id:'foreign-gap-room',engineId:'claude',messages:[],inputSources:[],briefingInputs:[]});
      ui.state.codex.activeThreadId='foreign-gap-room';ui.state.codex.activityRoomGeneration=(ui.state.codex.activityRoomGeneration||0)+1;
    }
    ui.notify();
    if(kind==='account') profile.auth.account=account;
    else {ui.state.codex.activeThreadId='ui';ui.state.codex.activityRoomGeneration++;}
    ui.notify();release();await opening;
    assert.equal(ui.document.getElementById('egd-codex-input-panel'),null,'nothing was published after the observed scope change');
    const rendered=JSON.stringify(attributes(ui.root))+ui.root.textContent;
    assert.equal(rendered.includes('SYNTHETIC_SOURCE'),false);
    assert.equal(rendered.includes(packet.packetId),false);
    assert.equal(rendered.includes(packet.receiptId),false);
    assert.equal(JSON.stringify(ui.state.codex.chatProtocol).includes('SYNTHETIC_SOURCE'),false);
  });
});

test('Claude receipt fence catches the microtask between completed digest read and inspector mount',async t=>{
  const {ui,packet}=await deliveredClaudeFixture(t);
  const profile=ui.state.codex.engines[1].profiles[0],account=profile.auth.account;
  let switched=false,listenersAtSwitch=null;
  ui.window.crypto={subtle:{digest:(...args)=>{
    const pending=webcrypto.subtle.digest(...args);
    pending.then(()=>queueMicrotask(()=>{
      // Registered before the production await: this runs after readInput's
      // digest continuation and cleanup, but before inspectInput resumes.
      listenersAtSwitch=ui.listenerCount();switched=true;
      profile.auth.account='FOREIGN_MICROTASK_ACCOUNT';ui.notify();
      profile.auth.account=account;ui.notify();
    }));
    return pending;
  }}};
  ui.state.codex.activityThreadId='ui';ui.render();
  await nodes(ui.panel(),'chat-delivered-input-open')[0].fire('click');
  assert.equal(switched,true);
  assert.equal(listenersAtSwitch,1,'the read watcher has cleaned up while the inspector handoff watcher remains');
  assert.equal(ui.document.getElementById('egd-codex-input-panel'),null);
  const rendered=JSON.stringify(attributes(ui.root))+ui.root.textContent;
  assert.equal(rendered.includes('SYNTHETIC_SOURCE'),false);
  assert.equal(rendered.includes(packet.packetId),false);assert.equal(rendered.includes(packet.receiptId),false);
  assert.equal(JSON.stringify(ui.state.codex.chatProtocol).includes('SYNTHETIC_SOURCE'),false);
});

test('real Context capability and pure planning admit direct, large and aggregate UI selections without preflight Reader execution',async t=>{
  for(const [name,contents,capacityKnown,expectedMode] of [
    ['B2 direct with unknown capacity',['small complete source'],false,'direct'],
    ['Reader-ready direct',['small complete source'],true,'direct'],
    ['large complete source',['SOURCE_LINE\n'.repeat(1000)],true,'reader'],
    ['aggregate of individually small sources',Array(3).fill('complete source '.repeat(20)),true,'reader'],
  ])await t.test(name,async t=>{
    const {ui,h,contexts,store,plans,replies,selected}=await contextSurface(t,{contents,capacityKnown});
    await ui.sendMessage();
    const capability=replies.find(row=>row.path==='/context/capabilities').body;
    assert.equal(capability.nativeReader,capacityKnown);
    assert.equal(capability.largeReader,capacityKnown);
    assert.equal(capability.reader.ready,capacityKnown);
    if(!capacityKnown)assert.equal(capability.reader.code,'ENGINE_CAPACITY_UNKNOWN');
    assert.ok(plans.length>=selected.length,JSON.stringify(replies.at(-1)));
    assert.ok(plans.every(plan=>plan.mode===expectedMode),JSON.stringify(plans));
    const send=ui.effects.requests.find(row=>row.path==='/chat/send').body;
    assert.deepEqual(send.contextCapabilities,{read:true,reader:capacityKnown,publishBriefing:false});
    assert.equal(send.expectedContextScope,capability.expectedContextScope);
    assert.equal(send.expectedContextScope,ui.effects.requests.find(row=>row.path==='/context/captures').body.expectedContextScope);
    for(const field of ['capacity','usage','readerBudget','ownerKey','epoch'])assert.equal(send[field],undefined);
    assert.equal(Object.values(ui.protocol.requests)[0].status,'accepted',JSON.stringify(replies.at(-1)));
    assert.equal(ui.state.codex.threadDrafts.ui,'');assert.deepEqual(ui.thread().inputSources,[]);
    assert.equal(contexts.smartRead.sessions.size,0);
    const owner=contexts.owner(h.chat.contextAuthority({engineId:'claude',engineProfileId:'claude-default',clientThreadId:'ui'}));
    for(const kind of ['readers','packets','deliveries'])assert.deepEqual(await store.listRecords(owner,kind),[]);
    assert.equal(h.events.some(event=>/^reader\.|^context\.read\./.test(event.event)),false);
    assert.equal(h.transports.length,1);assert.equal(h.transports[0].sent.length,1);assert.deepEqual(h.codexCalls,[]);
  });
});

test('unknown capacity and unavailable Reader retain complete large/aggregate selections with real server errors and no fallback',async t=>{
  for(const [capacityKnown,readerReady,code] of [[false,true,'ENGINE_CAPACITY_UNKNOWN'],[true,false,'READER_ISOLATION_UNAVAILABLE']]){
    for(const contents of [['SOURCE_LINE\n'.repeat(1000)],Array(3).fill('complete source '.repeat(20))])await t.test(`${code}/${contents.length}`,async t=>{
      const {ui,h,contexts,replies,selected}=await contextSurface(t,{contents,capacityKnown,readerReady});
      await ui.sendMessage();
      const capability=replies.find(row=>row.path==='/context/capabilities').body;
      assert.equal(capability.nativeReader,false);assert.equal(capability.largeReader,false);assert.equal(capability.reader.ready,false);
      assert.equal(replies.at(-1).body.code,code);
      assert.equal(ui.thread().sendError,ChatState.claudeContextSendErrorText(code));
      assert.equal(ui.state.codex.threadDrafts.ui,'  keep my draft  ');assert.deepEqual(ui.thread().inputSources,selected);
      assert.deepEqual(ui.thread().messages,[]);assert.equal(Object.values(ui.protocol.requests)[0].status,'failed');
      assert.equal(contexts.smartRead.sessions.size,0);assert.equal(h.transports.length,0);assert.deepEqual(h.codexCalls,[]);
      assert.equal(ui.effects.requests.length,3);assert.equal(ui.effects.timers,0);
    });
  }
});

test('Reader-ready capture cannot refresh its scope or send as another account before late SSE arrives',async t=>{
  const {ui,h,contexts,replies,selected}=await contextSurface(t,{contents:['complete small source'],
    beforeSend:async h=>h.changeAccount('changed-before-ui-sse@example.invalid')});
  const oldIdentity=clone(ui.state.codex.engines);
  await ui.sendMessage();
  assert.equal(replies[0].body.nativeReader,true);
  assert.equal(replies.at(-1).body.code,'CONTEXT_SCOPE_CHANGED');
  assert.deepEqual(ui.state.codex.engines,oldIdentity,'no account event reached the UI');
  assert.equal(ui.state.codex.threadDrafts.ui,'  keep my draft  ');assert.deepEqual(ui.thread().inputSources,selected);
  assert.deepEqual(ui.thread().messages,[]);assert.equal(Object.values(ui.protocol.requests)[0].status,'failed');
  assert.equal(ui.effects.requests.length,3,'one capability, capture and refused send, no scope refresh or resend');
  assert.equal(contexts.smartRead.sessions.size,0);assert.equal(h.transports.length,0);assert.deepEqual(h.codexCalls,[]);
  assert.equal(ChatState.chatThreadEngineLocked(ui.thread()),false);
});

test('production engine popover reanchors to its fresh local chip across Canvas pan/zoom and HUD', () => {
  const window = {innerWidth:1440, innerHeight:900};
  const geometry = compile(`${functionSource('resolveFloatingMenuPlacement')}\n${functionSource('positionChatEngineMenu')}
    return {place:resolveFloatingMenuPlacement, position:positionChatEngineMenu};`, {window});
  const toggleSource = source.match(/^      toggleEngineMenu\([^]*?^      \},/m)?.[0];
  assert.ok(toggleSource);
  const renderSource = between('      const engineContext = {', '      // CHAT-07: the profile peek') + '\n' +
    between('      const renderStatelessStart = (thread) => {', '      const renderThreadSection =');
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
      ChatState, BoardThread, codex:ui.state.codex, codexBridge:bridge, el:ui.el, deskIcon:()=>ui.el('span'),
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
    const taskReveal = productionController('createChatTaskAnswerReveal', body);
    assert.equal(body.events.wheel.length, 1); assert.equal(body.events.click.length, 1, 'real Task helper owns its scoped listeners');
    const attach = () => compile(attachmentSource, {body,el:ui.el,shellClasses:'egd-codex-chat-shell',
      contentChildren:[freshChip,menu],positionChatEngineMenu:geometry.position,taskAnswerReveal:taskReveal.instance});
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
    assert.equal(body.querySelector('[data-testid="chat-task-list"]'), null, 'popover case intentionally has no Task answer');
    assert.equal(taskReveal.pendingFrames(), 0, 'no Task reveal is fabricated for the independent popover case');
    taskReveal.instance.dispose();
    assert.ok(Object.values(body.events).every(listeners => listeners.length === 0), 'real helper releases listeners before the next scene');
  }
});

// Real adapter, runtime and SQLite public projections, with only the native
// stdio transport replaced. No provider, credential, CLI or OS calls.
async function runtime(t, { store = false, initialSend = true, contexts = null } = {}) {
  let chatStore = store && typeof store === 'object' ? store : null;
  if (store === true) {
    const dir = mkdtempSync(join(tmpdir(), 'egdesk-surface-claude-'));
    chatStore = openChatStore({ dataDir: dir, ownerScope: 'surface-test' });
    t.after(() => { chatStore.close(); rmSync(dir, { recursive: true, force: true }); });
  }
  const events = [], transports = [], timers = [], codexCalls = [];
  let account = 'test@example.invalid';
  const claude = createClaudeEngineAdapter({
    snapshot: () => ({ installed: true, version: '2.1.300', versionStatus: 'untested',
      auth: { status: 'signedIn', method: 'claudeai', account } }),
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
  const chat = new CodexChatRuntime({ engines: [codex, claude], store: chatStore, requireStore: !!chatStore, contexts,
    // This fixture's room-default DTO explicitly reports none. Keep the real
    // runtime comparison enabled without inventing an attached workspace.
    resolveProjectWorkspace: async () => null,
    now: () => NOW, emit: event => events.push(event), verifyFile: async () => null,
    setTimer: () => assert.fail('runtime retry timer'), clearTimer() {} });
  const unsubscribe = claude.subscribe({ notification: (_, message) => chat.handleNotification(message),
    serverRequest: (_, message) => chat.handleServerRequest(message),
    connection: (id, connection) => chat.setConnection(id, connection.ready, connection) });
  claude.syncStatus();
  const drain = async () => { await chat.queue; await new Promise(resolve => setImmediate(resolve)); await chat.queue; };
  t.after(async () => { unsubscribe(); await claude.dispose(); await drain(); });
  const result = initialSend ? await chat.send({ message: 'test', engineId: 'claude', clientThreadId: 'ui', requestId: 'request-1' }) : null;
  const run = result && chat.runs.get(`${result.conversationId}/${result.runId}`);
  return { chat, claude, result, run, events, transports, timers, codexCalls, drain,
    changeAccount: value => { account = value; claude.syncStatus(); },
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
  assert.deepEqual(buttons.map(button => button.textContent), ['이번만 허용', '거절', '취소']);
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
  assert.deepEqual(nodes(ui.panel(), 'chat-approval-choice').map(button => button.textContent), ['이번만 허용', '거절', '취소']);
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
  compile(block, { ChatState, BoardThread, run, conversation, el: ui.el, activeThread: ui.thread(),
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

test('unsupported Claude Context descriptor blocks capture/send without changing draft or selections', async () => {
  for (const selection of [{ inputSources: [{ ...fileInput(), resolverRef: 'ref' }] },
    { inputSources: [fileInput('ordinary-source')] }, { picked: ['context-choice'] },
    {inputSources:[{...fileInput(),kind:'browser',browserToolPermission:'interact'}]}]) {
    const ui = surface({ realCapture:true, thread: { ...selection }, auth: { isLoggedIn: false },
      fetchJson:async()=>{throw Object.assign(new Error('old bridge'),{status:404});} });
    ui.state.codex.connected = false;
    ui.state.codex.engines = [{ id: 'codex', status: 'offline' }, claudeRow()];
    ui.state.contextSuggest.byThread.ui = { picked: selection.picked || [], resolution: { resolutionId: 'keep-choice' } };
    const before = clone({ thread: ui.thread(), drafts: ui.state.codex.threadDrafts, context: ui.state.contextSuggest });
    await ui.sendMessage();
    assert.equal(ui.thread().sendError, ChatState.claudeContextSendErrorText('CLAUDE_CONTEXT_UNSUPPORTED'));
    const { sendError, preparingInput, ...after } = ui.thread();
    assert.deepEqual(after, before.thread);
    assert.deepEqual(ui.state.codex.threadDrafts, before.drafts);
    assert.deepEqual(ui.state.contextSuggest, before.context);
    const early=!!selection.picked || selection.inputSources?.[0].browserToolPermission==='interact';
    assert.deepEqual(ui.effects.capture, []); assert.equal(ui.effects.requests.length,early?0:1); assert.equal(ui.effects.ready, early?0:1);
    assert.ok(ui.effects.requests.every(row=>row.path.startsWith('/context/capabilities?')));
    assert.deepEqual(ui.protocol.requests, {}); assert.equal(ui.state.codex.recentEngineId, 'codex');
  }
  assert.equal(ChatState.claudeContextSendErrorText('UNKNOWN'), null);
  assert.equal(ChatState.claudeContextSendErrorText('CLAUDE_CONTEXT_UNSUPPORTED'),
    '현재 Claude 연결에서는 선택한 자료를 사용할 수 없어 보내지 않았습니다. 자료를 제외한 뒤 다시 보내세요.');
  const invalid = { snapshotId: 'briefing' };
  const ui = surface({thread:{briefingInputs:[invalid]},auth:{isLoggedIn:false}});
  await ui.sendMessage();
  assert.match(ui.thread().sendError,/브리핑 근거의 출처와 접근 권한/);
  assert.deepEqual(ui.thread().briefingInputs,[invalid]);
  assert.equal(ui.state.codex.threadDrafts.ui,'  keep my draft  ');
  assert.deepEqual(ui.effects.requests,[],'invalid briefing provenance never reaches the backend');
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

test('real Claude run.started without a profile survives a conflicting accepted HTTP response only for its captured owner',async t=>{
  for(const kind of ['same owner','explicit foreign event profile','foreign request profile','account round trip','profile round trip','room round trip']) await t.test(kind,async t=>{
    const h=await runtime(t,{store:true,initialSend:false});let ui;
    ui=surface({realProjection:true,auth:{isLoggedIn:false},fetchJson:async(path,options)=>{
      assert.equal(path,'/chat/send');
      const result=await h.chat.send(JSON.parse(options.body));
      const run=h.chat.runs.get(`${result.conversationId}/${result.runId}`);assert.ok(run);
      h.chat.emit(run,'run.started',{});
      const event=h.events.at(-1);
      assert.equal(event.event,'run.started');assert.equal(event.engineId,'claude');
      assert.equal(Object.hasOwn(event,'engineProfileId'),false,'the production emitter does not add a profile');
      // The conflict case modifies only the delivered event to test an
      // explicit future/invalid profile; the ordinary case is the real shape.
      const delivered=kind==='explicit foreign event profile'?{...event,engineProfileId:'foreign-slot'}:event;
      const observed=ChatState.reduceChatEvent(ui.protocol,delivered,['claude']);assert.ok(observed);
      assert.equal(observed.engineProfileId,kind==='explicit foreign event profile'?'foreign-slot':undefined);
      if(kind!=='explicit foreign event profile') ui.syncRun(observed);
      ui.notify();
      const request=ui.protocol.requests[event.requestId];
      assert.equal(request.status,'accepted','the same-request SSE was reduced before the HTTP response');
      assert.equal(request.engineProfileId,'claude-default','the profile is captured with the original request');
      ui.state.codex.threadDrafts.ui='newer draft';ui.state.codex.threadDraftRevisions.ui++;
      ui.thread().inputSources=[fileInput('newer')];
      if(kind==='foreign request profile') request.engineProfileId='foreign-slot';
      if(kind==='account round trip') {
        const auth=ui.state.codex.engines[1].profiles[0].auth,original=auth.account;
        auth.account='foreign@example.invalid';ui.notify();auth.account=original;ui.notify();
      }
      if(kind==='profile round trip') {
        ui.thread().engineProfileId='foreign-slot';ui.notify();ui.thread().engineProfileId='claude-default';ui.notify();
      }
      if(kind==='room round trip') {
        ui.state.codex.threads.push({id:'foreign-room',engineId:'claude',messages:[],inputSources:[],briefingInputs:[]});
        ui.state.codex.activeThreadId='foreign-room';ui.state.codex.activityRoomGeneration=(ui.state.codex.activityRoomGeneration||0)+1;ui.notify();
        ui.state.codex.activeThreadId='ui';ui.state.codex.activityRoomGeneration++;ui.notify();
      }
      return {...result,engineId:'codex'};
    }});
    ui.subscribe(()=>{})();
    const result=await ui.sendMessage(),expected=kind==='same owner'?'accepted':'unconfirmed';
    assert.deepEqual({accepted:result.accepted,status:result.status},{accepted:kind==='same owner',status:expected});
    const request=Object.values(ui.protocol.requests)[0];
    assert.equal(request.status,expected);assert.equal(request.acceptedInputMessageId,undefined);
    assert.equal(ui.state.codex.threadDrafts.ui,'newer draft');assert.deepEqual(ui.thread().inputSources,[fileInput('newer')]);
    await ui.sendMessage();
    assert.equal(ui.effects.requests.filter(row=>row.path==='/chat/send').length,1);
    assert.equal(h.transports[0].sent.length,1);assert.equal(ui.effects.timers,0);
  });
});

test('foreign Claude HTTP route withholds its receipt without downgrading an independently accepted SSE',async t=>{
  for(const [kind,foreign] of [
    ['engine',{engineId:'FOREIGN_ENGINE'}],['profile',{engineProfileId:'FOREIGN_PROFILE'}],
    ['nested engine',{engine:{id:'FOREIGN_ENGINE'}}],['nested profile',{engine:{engineProfileId:'FOREIGN_PROFILE'}}],
  ]) for(const eventFirst of [false,true]) await t.test(`${kind}; ${eventFirst?'prior same-engine event':'no prior event'}`,async()=>{
    const inputs=[fileInput('keep')];let ui;
    ui=surface({thread:{inputSources:inputs},fetchJson:async(path,options)=>{
      assert.equal(path,'/chat/send');const requestId=JSON.parse(options.body).requestId;
      if(eventFirst) {
        ChatState.reduceChatEvent(ui.protocol,{type:'chat.event',v:2,event:'run.started',streamId:'own-stream',seq:1,
          engineId:'claude',engineProfileId:'claude-default',clientThreadId:'ui',requestId,
          conversationId:'own-conversation',runId:'own-run',answerId:'own-conversation/own-run',details:{}},['claude']);
        ui.state.codex.threadDrafts.ui='newer draft';ui.state.codex.threadDraftRevisions.ui++;
        ui.thread().inputSources=[fileInput('newer')];
      }
      return {accepted:true,durable:true,requestId,clientThreadId:'ui',conversationId:'FOREIGN_CONVERSATION',
        runId:'FOREIGN_RUN',answerId:'FOREIGN_CONVERSATION/FOREIGN_RUN',localConversationId:'FOREIGN_LOCAL_CONVERSATION',
        localRunId:'FOREIGN_LOCAL_RUN',localMessageId:'FOREIGN_MESSAGE',...foreign};
    }});
    ui.subscribe(()=>{})(); // Production normalizes the thread before the send watch is installed.
    const result=await ui.sendMessage();
    assert.deepEqual({accepted:result.accepted,status:result.status},eventFirst?{accepted:true,status:'accepted'}:{accepted:false,status:'unconfirmed'});
    assert.equal(ui.state.codex.threadDrafts.ui,eventFirst?'newer draft':'  keep my draft  ');
    assert.deepEqual(ui.thread().inputSources,eventFirst?[fileInput('newer')]:inputs);
    assert.equal(ui.thread().engineId,'claude');assert.equal(ui.thread().engineProfileId,'claude-default');
    assert.equal(Object.values(ui.protocol.requests)[0].status,eventFirst?'accepted':'unconfirmed');
    assert.ok(Object.values(ui.protocol.requests).every(request=>!request.acceptedInputMessageId));
    assert.equal(JSON.stringify(ui.state).includes('FOREIGN_'),false,'the conflicting response IDs never enter state');
    assert.doesNotMatch(ui.thread().sendError,/FOREIGN_/);
    ui.state.codex.activityThreadId='ui';ui.render();
    assert.doesNotMatch(JSON.stringify(attributes(ui.root))+ui.root.textContent,/FOREIGN_/,'the conflicting response IDs never reach the DOM');
    await ui.sendMessage();
    assert.equal(ui.effects.requests.filter(row=>row.path==='/chat/send').length,1,'neither an unknown outcome nor an accepted run is automatically retried');
    assert.equal(ui.effects.timers,0);
  });
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
    const briefings = [];
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
    const fetchJson = compile(`${between('    const fetchJson = async', '\n\n    // One catalog read')}\nreturn fetchJson;`, {BoardThread,
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

test('real HTTP 422 binary rejection and durable rejected reply keep draft/selections and unlock actual engine selection',async()=>{
  for(const status of [422,202]){
    const rejection={code:'UNSUPPORTED_SOURCE_FORMAT',message:'Unsupported immutable source format'};
    const payload={accepted:false,code:rejection.code,dispatchStatus:'rejected',resumeRequired:false,saved:true,durable:true,
      ...(status===202?{duplicate:true,status:'rejected',conversationId:null,
        error:{...rejection,origin:'claude',kind:'unknown'}}:{error:rejection.message})};
    const sendBodies=[];
    const fetchJson=compile(`${between('    const fetchJson = async','\n\n    // One catalog read')}\nreturn fetchJson;`,{BoardThread,
      fetch:async(url,options={})=>{
        const path=new URL(url).pathname;
        const body=options.body&&JSON.parse(options.body);
        const reply=path==='/context/capabilities'?b2Capability:path==='/context/captures'?captureReply(body):payload;
        const responseStatus=path==='/chat/send'?status:200;
        if(path==='/chat/send')sendBodies.push(body);
        return{ok:responseStatus<400,status:responseStatus,text:async()=>JSON.stringify(reply),json:async()=>reply};
      },
    });
    const selected=[fileInput('unsupported-binary')];
    const ui=surface({realCapture:true,thread:{inputSources:selected},fetchJson});
    await ui.sendMessage();
    assert.equal(sendBodies.length,1);
    assert.deepEqual(sendBodies[0].contextSnapshotIds,['stored-unsupported-binary']);
    assert.equal(sendBodies[0].expectedContextScope,b2Capability.expectedContextScope);
    assert.equal(ui.thread().sendError,ChatState.claudeContextSendErrorText('UNSUPPORTED_SOURCE_FORMAT'));
    assert.deepEqual(ui.thread().messages,[],'definitively refused optimistic row is not a sent conversation');
    assert.equal(ui.state.codex.threadDrafts.ui,'  keep my draft  ');
    assert.deepEqual(ui.thread().inputSources,selected);
    assert.equal(Object.values(ui.protocol.requests)[0].status,'failed');
    assert.equal(ChatState.chatThreadEngineLocked(ui.thread()),false);
    ui.setThreadEngine('ui','codex');
    assert.equal(ui.thread().engineId,'codex');
    assert.equal(ChatState.chatThreadEngineProfileId(ui.thread(),ui.state.codex),'codex-default');
    assert.deepEqual(ui.thread().inputSources,selected);
    assert.equal(ui.effects.requests.length,3);assert.equal(ui.effects.timers,0);
  }
});

test('real HTTP uncertain failures retain their optimistic row and do not unlock engine switching',async()=>{
  for(const failure of [null,{status:502,payload:{code:'TOOL_PROVIDER_FAILED',error:'connection lost'}},
    {status:422,payload:{accepted:false,code:'UNSUPPORTED_SOURCE_FORMAT',resumeRequired:true,error:'dispatch may have occurred'}},
    {status:409,payload:{accepted:false,dispatchStatus:'unknown',
      error:{code:'TURN_START_FAILED',origin:'claude',message:'Fake lost native reply',kind:'unknown'}}},
    {status:202,payload:{accepted:false,dispatchStatus:'unknown',durable:true,duplicate:true,runId:null,conversationId:'exists',
      error:{code:'TURN_START_FAILED',origin:'claude',message:'lost reply',kind:'unknown'}}}]){
    const fetchJson=compile(`${between('    const fetchJson = async','\n\n    // One catalog read')}\nreturn fetchJson;`,{BoardThread,
      fetch:async()=>{
        if(!failure)throw new Error('network disconnected');
        return{ok:failure.status<400,status:failure.status,text:async()=>JSON.stringify(failure.payload),json:async()=>failure.payload};
      },
    });
    const selected=[fileInput('retained-uncertain')];
    const ui=surface({thread:{inputSources:selected},fetchJson});
    await ui.sendMessage();
    assert.equal(ui.thread().messages.length,1);
    assert.equal(ui.thread().messages[0].status,'unconfirmed');
    assert.equal(Object.values(ui.protocol.requests)[0].status,'unconfirmed');
    assert.match(ui.thread().sendError,/접수 여부를 확인하지 못했습니다/);
    assert.equal(ui.thread().sendError.includes('[object Object]'),false);
    if(failure?.payload?.error?.code==='TURN_START_FAILED'){
      assert.equal(Object.hasOwn(failure.payload,'resumeRequired'),false);
      assert.equal(Object.hasOwn(failure.payload,'code'),false);
      assert.equal(ui.thread().sendError,`접수 여부를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다. ${failure.payload.error.message}`);
    }
    assert.equal(ui.state.codex.threadDrafts.ui,'  keep my draft  ');
    assert.deepEqual(ui.thread().inputSources,selected);
    ui.setThreadEngine('ui','codex');assert.equal(ui.thread().engineId,'claude');
    if(failure?.status===202){
      assert.equal(ui.thread().conversationId,'exists');
      assert.equal(ui.thread().engineProfileId,'claude-default');
      assert.equal(ui.thread().bindingState,'server-check-required');
    }
    assert.equal(ui.effects.requests.length,1);assert.equal(ui.effects.timers,0);
  }
});

test('exact durable unknown with nested Context error is not a refusal, acceptance or permission to resend',async()=>{
  for(const code of ['CLAUDE_CONTEXT_READER_UNSUPPORTED','ENGINE_CAPACITY_UNKNOWN','READER_FAILED']){
  const payload={accepted:false,dispatchStatus:'unknown',
    error:{code,message:code==='CLAUDE_CONTEXT_READER_UNSUPPORTED'?'Reader reply was lost':'PRIVATE_READER_DETAILS'},duplicate:true};
  const selected=[fileInput('retained-reader')];
  const ui=surface({realCapture:true,thread:{inputSources:selected},fetchJson:async(path,options)=>{
    if(path.startsWith('/context/capabilities?'))return b2Capability;
    if(path==='/context/captures')return captureReply(JSON.parse(options.body));
    assert.equal(path,'/chat/send');return payload;
  }});
  await ui.sendMessage();
  assert.equal(Object.values(ui.protocol.requests)[0].status,'unconfirmed');
  assert.equal(ui.thread().messages.length,1);
  assert.equal(ui.thread().messages[0].status,'unconfirmed');
  assert.equal(ui.thread().sendError,`접수 여부를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다. ${ChatState.claudeContextReadErrorText(code)||payload.error.message}`);
  assert.doesNotMatch(ui.thread().sendError,/PRIVATE_READER_DETAILS|전송하지 않았으며/);
  assert.equal(ui.state.codex.threadDrafts.ui,'  keep my draft  ');
  assert.deepEqual(ui.thread().inputSources,selected);
  assert.equal(ui.effects.synced.length,0);
  ui.setThreadEngine('ui','codex');
  assert.equal(ui.thread().engineId,'claude');
  await ui.sendMessage();
  assert.equal(ui.effects.requests.length,3,'unconfirmed request remains blocked without an automatic or repeated send');
  assert.equal(ui.effects.timers,0);
  }
});

test('definite Claude failures remove only the optimistic row and an empty room can explicitly change engine',async()=>{
  for(const status of [409,202])for(const previous of [null,{id:'older',role:'user',content:'earlier accepted message',status:'complete'}]){
    const payload={accepted:false,dispatchStatus:'rejected',error:{code:'TURN_START_FAILED',message:'Dispatch definitely refused'},duplicate:status===202};
    const fetchJson=compile(`${between('    const fetchJson = async','\n\n    // One catalog read')}\nreturn fetchJson;`,{BoardThread,
      fetch:async()=>({ok:status<400,status,text:async()=>JSON.stringify(payload),json:async()=>payload}),
    });
    const ui=surface({thread:{messages:previous?[clone(previous)]:[]},fetchJson});
    await ui.sendMessage();
    assert.equal(Object.values(ui.protocol.requests)[0].status,'failed');
    assert.deepEqual(ui.thread().messages,previous?[previous]:[]);
    assert.equal(ui.state.codex.threadDrafts.ui,'  keep my draft  ');
    assert.equal(ui.effects.synced.length,0);
    assert.equal(ChatState.chatThreadEngineLocked(ui.thread()),!!previous);
    ui.setThreadEngine('ui','codex');
    assert.equal(ui.thread().engineId,previous?'claude':'codex');
    assert.equal(ui.effects.requests.length,1);assert.equal(ui.effects.timers,0);
  }
});

test('actual reopened-store unknown replay without resumeRequired keeps the UI unconfirmed and its Claude binding',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'egdesk-surface-replay-'));
  const stores=[];
  const openStore=()=>{const store=openChatStore({dataDir:dir,ownerScope:'surface-test'});stores.push(store);return store;};
  t.after(()=>{for(const store of stores)store.close();rmSync(dir,{recursive:true,force:true});});
  const firstStore=openStore();
  const first=await runtime(t,{store:firstStore,initialSend:false});
  const start=first.claude.startTurn;
  first.claude.startTurn=async params=>{
    await start(params);
    throw Object.assign(new Error('Fake lost native reply'),{code:'CLAUDE_CONTEXT_READER_UNSUPPORTED',httpStatus:409});
  };
  let replay,restarted;
  const fetchJson=compile(`${between('    const fetchJson = async','\n\n    // One catalog read')}\nreturn fetchJson;`,{BoardThread,
    fetch:async(url,options)=>{
      const body=JSON.parse(options.body);
      // Produce the real durable replay at the HTTP boundary. The UI makes
      // exactly one request; this setup models an earlier lost native reply.
      await assert.rejects(first.chat.send(body),error=>error.resumeRequired===true&&error.dispatchStatus==='unknown');
      assert.equal(first.transports[0].sent.length,1);
      await first.claude.dispose();await first.drain();firstStore.close();
      restarted=await runtime(t,{store:openStore(),initialSend:false});
      const auth=createChatEngineAuth({chat:restarted.chat,
        refreshCodexAccount:async()=>assert.fail('Claude replay must not authenticate Codex'),getCodexAuth:()=>({isLoggedIn:false})});
      const handler=createChatHttpHandler(restarted.chat,auth);
      const req=Readable.from([Buffer.from(options.body)]);
      Object.assign(req,{method:'POST',url:'/chat/send',headers:{host:'127.0.0.1:39218','content-type':'application/json'},
        socket:{remoteAddress:'127.0.0.1'}});
      const res={writeHead(status){this.status=status;},end(value){this.body=JSON.parse(value);}};
      assert.equal(await handler(req,res,new URL(url)),true);
      assert.equal(res.status,202);
      replay=res.body;
      assert.equal(Object.hasOwn(replay,'resumeRequired'),false,'exercise the stored shape, never add a flag');
      assert.equal(Object.hasOwn(replay,'code'),false);
      assert.deepEqual([replay.accepted,replay.dispatchStatus,replay.duplicate,replay.runId],[false,'unknown',true,null]);
      assert.deepEqual(replay.error,{code:'TURN_START_FAILED',origin:'claude',message:'Fake lost native reply',kind:'unknown'});
      return{ok:true,status:res.status,json:async()=>replay};
    },
  });
  const ui=surface({fetchJson});
  await ui.sendMessage();
  assert.equal(ui.thread().messages.length,1);
  assert.equal(ui.thread().messages[0].status,'unconfirmed');
  assert.equal(Object.values(ui.protocol.requests)[0].status,'unconfirmed');
  assert.equal(ui.thread().sendError,'접수 여부를 확인하지 못했습니다. 자동으로 다시 보내지 않습니다. Fake lost native reply');
  assert.equal(ui.state.codex.threadDrafts.ui,'  keep my draft  ');
  assert.equal(ui.thread().conversationId,replay.conversationId);
  assert.equal(ui.thread().bindingState,'server-check-required');
  assert.equal(ui.thread().engineProfileId,'claude-default');
  ui.setThreadEngine('ui','codex');
  assert.equal(ui.thread().engineId,'claude');
  assert.equal(ui.thread().conversationId,replay.conversationId);
  assert.equal(ui.effects.requests.length,1);assert.equal(ui.effects.timers,0);
  assert.equal(restarted.transports.length,0,'replaying a durable outcome starts no new native transport');
  assert.deepEqual([...first.codexCalls,...restarted.codexCalls],[]);
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

test('D-X3 Claude cwd refusal preserves the original draft and explicit target without silently forking', async t => {
  for (const code of ['CWD_CHANGE_UNSUPPORTED', 'NATIVE_CWD_UNVERIFIED']) await t.test(code, async () => {
    const target = { boardId: 'board', projectId: 'project', rootId: 'root', title: 'Selected', displayPath: '/reviewed/folder' };
    const ui = surface({ thread: { conversationId: 'native-original', requestProjectTarget: target }, fetchJson: async path => {
      assert.equal(path, '/chat/send');
      throw Object.assign(new Error('original cwd'), { code, status: 409, accepted: false, dispatchStatus: 'not-dispatched' });
    } });
    await ui.sendMessage();
    assert.equal(ui.effects.requests.length, 1);
    assert.equal(ui.state.codex.threads.length, 1);
    assert.equal(ui.thread().conversationId, 'native-original');
    assert.equal(ui.state.codex.threadDrafts.ui, '  keep my draft  ');
    assert.deepEqual(ui.thread().requestProjectTarget, target);
    assert.match(ui.thread().sendError, /시작 폴더.*새 대화 열기.*기존 초안과 선택은 유지/);
  });
});
