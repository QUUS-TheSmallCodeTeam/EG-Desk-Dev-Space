import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { compileFunction, runInNewContext } from 'node:vm';
import { originCommandSelector, chatOriginFileOptions, assertChatOriginFilePeer, assertOriginReadWindow,
  assertCurrentOriginFileUi, assertOriginActiveRoom, observeChatOriginFileUi, originEditorVisible,
  readOriginEditorGeometry, observeOriginDesk, observeOriginProjectUi, assertOriginRoomProjectReview,
  prepareOriginRoomForSend, originNewRoomReady, enterOriginNewRoom, clickOriginPoint } from './verify-firefox-mcp-chat-origin-file-flow.mjs';
import { CHAT_ORIGIN_FILE_TEXT, CHAT_ORIGIN_FILE_OUTPUT, CHAT_ORIGIN_FILE_BOARDS } from './egdesk-chat-origin-file-fixture.mjs';
import { readSurfaceSource } from './egdesk-surface-source.mjs';
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';
import { targetIssues } from './verify-firefox-mcp-headless-ui-regression.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const env = { EGDESK_QA_CHAT_ORIGIN_FILE_FIXTURE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_REAL_TURN: '0',
  EGDESK_QA_FIXTURE_PORT: '49321', EGDESK_QA_FIXTURE_TOKEN: 'owned-origin-verifier-token', MOZ_HEADLESS: '1', EGDESK_MARIONETTE_PORT: '2829' };
const now = Date.parse('2026-10-25T22:40:00Z'), argv = ['--profile', '/owned/profile', '--deadline-utc', '2026-10-25T22:46:00Z'];
const original = { conversationId: 'native-original', runId: 'run-original', itemId: 'command-original', clientThreadId: 'room-original', requestId: 'request-original' };
const initialRoom = { id: 'initial-ui-room', clientThreadId: original.clientThreadId };
const rectangle = (left = 20, top = 20, width = 200, height = 120) => ({ left, top, width, height, right: left + width, bottom: top + height });
function editorNode() {
  const style = { display: 'block', visibility: 'visible', opacity: '1', overflowX: 'visible', overflowY: 'visible' };
  const node = { isConnected: true, hidden: false, parentElement: null, style,
    clientWidth: 200, clientHeight: 120, scrollWidth: 200, scrollHeight: 120, scrollTop: 0, scrollLeft: 0,
    getBoundingClientRect: () => rectangle(), contains: () => false };
  node.ownerDocument = { elementFromPoint: () => node,
    defaultView: { innerWidth: 800, innerHeight: 600, getComputedStyle: value => value.style } };
  return node;
}
// Model-only validator inputs. The companion factory tests exercise actual
// accepted chat.send and SQLite; these objects are never served to product UI.
function state() {
  return { kind: 'egdesk-chat-origin-file-fixture', fixture: true, disposed: false, profile: '/owned/profile', host: '127.0.0.1', port: 49321, origin: 'http://127.0.0.1:49321',
    original: { ...original }, folders: { original: '/owned/original', other: '/owned/other' }, sourcePath: '/owned/original/source.test.js',
    projects: { original: { projectId: 'original-project', rootId: 'original-root', directoryId: 'original-directory' }, other: { projectId: 'other-project', rootId: 'other-root' } },
    effects: { providerTurns: 0, shellExecutions: 0, nativeProcessSpawns: 0, nativePickerInvocations: 0, approvalPosts: 0,
      uiOriginalWriteAttempts: 0, uiOriginalWrites: 0, gitAttempts: 0, nativeCreateAttempts: 0, setupSourceWrites: 2,
      setupPickerGrants: 2, profileCatalogWrites: 1, controlledSourceWrites: 1, managedDraftSqlWrites: 0 },
    persisted: { requests: 1, events: 9, drafts: 0, origins: [{ conversationId: original.conversationId, runId: original.runId,
      clientThreadId: original.clientThreadId, requestId: original.requestId, project: { projectId: 'original-project', startCwd: '/owned/original' } }] },
    fakeRpc: [{ method: 'thread/start' }, { method: 'turn/start' }], controls: [{ action: 'advance-current' }], frames: [],
    registrations: [{ rootId: 'original-root' }, { rootId: 'other-root' }], requests: [],
    retainedOutputSha256: hash(CHAT_ORIGIN_FILE_OUTPUT), sourceSha256: hash(CHAT_ORIGIN_FILE_TEXT.current), otherSha256: hash(CHAT_ORIGIN_FILE_TEXT.other) };
}
function windowPair() {
  const before = state(), after = structuredClone(before);
  after.effects.managedDraftSqlWrites++; after.persisted.drafts++;
  const origin = () => ({ path: '/chat/run-project-origin', method: 'GET', status: 200, delegated: true,
    query: { conversationId: original.conversationId, runId: original.runId }, response: { verified: true, rootId: 'original-root', directoryId: 'original-directory', displayPath: '/owned/original' } });
  after.requests = [origin(), { path: '/v1/files/list', method: 'POST', status: 200, delegated: true, request: { directoryId: 'original-directory', cursor: 0, limit: 100 } },
    { path: '/v1/files/resolve', method: 'POST', status: 200, delegated: true, request: { rootId: 'original-root', path: before.sourcePath }, response: { result: { id: 'current-file' } } },
    { path: '/v1/files/read', method: 'POST', status: 200, delegated: true, request: { fileId: 'current-file' } },
    { path: '/v1/files/drafts/create', method: 'POST', status: 200, delegated: true, request: { fileId: 'current-file' },
      response: { result: { id: 'real-draft', rootId: 'original-root', fileId: 'current-file' } } }, origin()];
  for (const row of after.requests) row.query ??= {};
  return { before, after };
}
function views() {
  const before = { thread: { ...initialRoom, conversationId: original.conversationId, requestProjectTarget: { projectId: 'other-project' } }, command: { count: 1,
    identity: { conversationId: original.conversationId, runId: original.runId, itemId: original.itemId }, tail: CHAT_ORIGIN_FILE_OUTPUT.trimEnd() }, cards: [{ id: 'egd-file-card-1' }] };
  const after = structuredClone(before);
  after.cards.push({ id: 'egd-file-card-2', ready: true, openStatus: 'opened', busy: 'false', inert: false,
    snapshot: { rootId: 'original-root', fileId: 'current-file', draftId: 'real-draft' },
    editor: { value: CHAT_ORIGIN_FILE_TEXT.current, visible: true, geometry: readOriginEditorGeometry(editorNode()) },
    badge: { text: '현재 파일', visible: true }, notice: { paragraphs: [
      { text: '현재 파일 · 이전 실행의 출력에서 열었습니다. 당시 내용과 다를 수 있습니다.', painted: true },
      { text: '경로 · /owned/original/source.test.js', painted: true }],
      details: [{ open: false, summary: '출처 상세', text: `출처 상세 이전 실행 ${original.runId} 원래 대화 ${original.conversationId} 명령 항목 ${original.itemId} 당시 행 참조 2행 3열` }] } });
  return { before, after };
}

function preparation(status = 'none') {
  const peer = state(), connected = status === 'connected', source = connected ? 'board' : 'none';
  peer.original = null; peer.fakeRpc = []; peer.preparedRoom = connected ? initialRoom.clientThreadId : null;
  peer.persisted = { requests: 0, events: 0, drafts: 0, origins: [] };
  const value = { roomId: initialRoom.clientThreadId, status, source: connected ? 'board' : null,
    inheritance: connected ? { boardId: CHAT_ORIGIN_FILE_BOARDS.original } : null, override: null,
    project: connected ? { ...peer.projects.original, displayPath: peer.folders.original, title: 'QA Original Project' } : null };
  peer.requests = [{ sequence: connected ? 2 : 1, path: '/v1/files/projects/room-default', method: 'POST', status: 200,
    delegated: true, query: {}, request: { roomId: initialRoom.clientThreadId }, response: { ok: true, result: value } }];
  const view = { thread: { ...initialRoom, conversationId: null, messages: 0, requestProjectTarget: null, sendError: null },
    panelCount: 1, panelThreadId: initialRoom.id, chip: { count: 1, source, text: connected ? 'Board 상속 · QA Original Project' : '실행 프로젝트' },
    effective: { source, title: connected ? 'Board 상속 · QA Original Project' : undefined,
      path: connected ? peer.folders.original : undefined, geometry: readOriginEditorGeometry(editorNode()) },
    summary: { status, source } };
  return { peer, view };
}

function productRoomControls(source = readSurfaceSource()) {
  class Element {
    constructor(tag, text = '') { this.tag = tag; this.text = text; this.children = []; this.dataset = {}; this.attributes = {}; this.events = {}; this.style = {}; }
    appendChild(node) { this.children.push(node); return node; }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    addEventListener(name, handler) { this.events[name] = handler; }
    get textContent() { return this.text + this.children.map(node => node.textContent).join(''); }
    querySelectorAll(selector) {
      const matches = node => selector.startsWith('.') ? node.className?.split(' ').includes(selector.slice(1))
        : node.dataset.testid === /^\[data-testid="([^"]+)"\]$/.exec(selector)?.[1];
      return this.children.flatMap(node => [...(matches(node) ? [node] : []), ...node.querySelectorAll(selector)]);
    }
  }
  const document = { createElement: tag => new Element(tag), createTextNode: text => new Element('#text', text) };
  const state = { codex: { threads: [], threadNonce: 0, threadDrafts: {}, hudView: 'list' } }, opened = [];
  const declaration = name => { const match = source.match(new RegExp(`^  function ${name}\\([^]*?^  \\}`, 'm')); assert.ok(match, name); return match[0]; };
  const deps = { document, state, ChatState, SELF_MEMBER: 'self', uniqueNames: names => [...new Set(names)],
    codexAgentProfile: () => ({}), buildThreadSubtitle: () => '', emit() {}, chatProjectDraftActions: new Map(),
    chatRequestProjectSelection: () => ({ target: null, invalid: false }),
    chatRoomProjectState: () => ({ status: 'ready', value: { status: 'none' } }),
    openChatRequestProjectPanel: id => opened.push(id) };
  const functions = ['el', 'createCodexThread', 'buildChatRequestProjectControl', 'buildChatInputTray'];
  const method = source.match(/^      createThread\([^]*?^      \},/m); assert.ok(method);
  const api = compileFunction(functions.map(declaration).join('\n') + `\nreturn { el, buildChatInputTray, bridge: { ${method[0].slice(0, -1)} } };`,
    Object.keys(deps))(...Object.values(deps));
  const start = source.indexOf('      if (isHudListView) {\n        threadTop.appendChild');
  const end = source.indexOf('\n      const threadSearch = ', start);
  assert.ok(start >= 0 && end > start, 'missing the product HUD list header');
  const renderTop = compileFunction(source.slice(start, end), ['isHudListView', 'threadTop', 'el', 'codexBridge']);
  const top = new Element('div'), hiddenTop = new Element('div');
  renderTop(true, top, api.el, api.bridge);
  renderTop(false, hiddenTop, api.el, api.bridge);
  return { state, opened, top, hiddenTop, tray: () => api.buildChatInputTray(state.codex.threads[0], { ensureRoomProjectDefault() {} }) };
}

test('origin verifier: real product new-room handler and real tray DOM own the exact selectors and active-room binding', () => {
  const verify = source => {
    const product = productRoomControls(source), buttons = product.top.querySelectorAll('.egd-codex-thread-home-new');
    assert.equal(buttons.length, 1); assert.equal(product.hiddenTop.querySelectorAll('.egd-codex-thread-home-new').length, 0);
    buttons[0].events.click();
    assert.equal(product.state.codex.hudView, 'conversation'); assert.equal(product.state.codex.threads.length, 1);
    const thread = product.state.codex.threads[0], tray = product.tray();
    assert.equal(product.state.codex.activeThreadId, thread.id); assert.equal(thread.type, 'dm');
    assert.equal(thread.profileEnabled, false); assert.equal(thread.conversationId, null);
    assert.equal(tray.dataset.testid, 'chat-attachments'); assert.equal(tray.dataset.threadId, thread.id);
    const openers = tray.querySelectorAll('[data-testid="chat-project-open"]'); assert.equal(openers.length, 1);
    assert.equal(tray.querySelectorAll('[data-testid="chat-project-target"]').length, 1);
    openers[0].events.click(); assert.deepEqual(product.opened, [thread.id]);
  };
  const source = readSurfaceSource(); verify(source);
  assert.throws(() => verify(source.replace("testid: 'chat-project-open'", "testid: 'renamed-project-open'")), /0 !== 1/);
  assert.throws(() => verify(source.replace("class: 'egd-codex-thread-home-new'", "class: 'renamed-new-room'")), /0 !== 1/);
  const openHandler = "onclick: () => codexBridge.createThread('dm', { openConversation: true }),";
  assert.ok(source.includes(openHandler));
  assert.throws(() => verify(source.replace(openHandler, openHandler.replace('openConversation: true', 'openConversation: false'))),
    error => error instanceof assert.AssertionError && error.actual === 'list' && error.expected === 'conversation');
  const activeBinding = 'state.codex.threads = [thread, ...state.codex.threads];\n        state.codex.activeThreadId = thread.id;';
  assert.ok(source.includes(activeBinding));
  assert.throws(() => verify(source.replace(activeBinding, activeBinding.replace('activeThreadId = thread.id', 'activeThreadId = null'))),
    error => error instanceof assert.AssertionError && error.actual === null && /^thread-dm-/.test(error.expected));
  const reference = readFileSync(new URL('./verify-firefox-mcp-project-file-flow.mjs', import.meta.url), 'utf8');
  assert.match(reference, /newRoomAction = await click\('\.egd-codex-thread-home-new'/);
  assert.match(reference, /openerCount === 1 && value\.composerBox\?\.visible && value\.composerThreadId === value\.threadId/);
});

test('origin verifier: acknowledged new-room click cannot promote the old list room or an unrelated composer', async () => {
  const before = { account: { connected: true, loggedIn: true, key: 'account' }, hudView: 'list', threadIds: ['old'],
    thread: { id: 'old' }, homeNewCount: 1, backCount: 0, openerCount: 0, composer: { count: 0, visible: false } };
  const after = { ...structuredClone(before), hudView: 'conversation', threadIds: ['fresh', 'old'],
    thread: { id: 'fresh', clientThreadId: 'fresh', messages: 0, profileEnabled: false }, homeNewCount: 0, backCount: 1, openerCount: 1,
    composer: { count: 1, visible: true, threadId: 'fresh' } };
  assert.equal(originNewRoomReady(after, before), true);
  for (const mutate of [value => { value.thread.id = 'old'; }, value => { value.hudView = 'list'; },
    value => { value.composer.threadId = 'other'; }, value => { value.openerCount = 0; },
    value => { value.account.key = 'other'; }, value => { value.composer.visible = false; }]) {
    const value = structuredClone(after); mutate(value); assert.equal(originNewRoomReady(value, before), false);
  }
  for (const completed of [false, true]) {
    const actions = [], trace = {}; let clicked = false, samples = 0;
    const pending = enterOriginNewRoom({ evaluateChrome: async () => clicked && completed && ++samples > 1 ? after : before }, {
      click: async selector => { actions.push(selector); clicked = true; }, trace,
      waitUntil: async (read, accept) => { for (let i = 0; i < 3; i++) { const value = await read(); if (accept(value)) return value; } throw new Error('new room was not rendered'); },
    });
    if (completed) assert.equal((await pending).id, 'fresh');
    else { await assert.rejects(pending, /new room was not rendered/); assert.equal(trace.last.hudView, 'list'); }
    assert.deepEqual(actions, ['.egd-codex-thread-home-new'], 'No click retry or old-room/project fallback');
  }
});

test('origin verifier: stable nine-hit center dispatches one point input with no UID or DOM-scroll path', async () => {
  const scripts = [], points = [], trace = []; let reads = 0;
  const screen = { width: 800, height: 600, threadId: 'room', clientThreadId: 'wire', hudView: 'list', accountKey: 'a', fullscreen: null, panelThreadId: null };
  const target = { visible: true, disabled: false, readOnly: false, inViewport: true, hitCount: 9, rect: { x: 20, y: 40, width: 30, height: 40 } };
  const harness = { evaluateChrome: async script => { scripts.push(script); return structuredClone(screen); },
    clickPoint: async point => points.push(point), click: () => assert.fail('No UID input'), uidFor: () => assert.fail('No UID lookup'),
    scrollWithKey: () => assert.fail('No scroll fallback') };
  const options = { deadlineMs: Date.now() + 10000, trace, targetIssues,
    observeViewport: async () => ({ width: 800, height: 600 }), waitStableViewport: async () => {},
    observeTargets: async () => { reads++; return [structuredClone(target)]; },
    waitUntil: async (read, accept) => { for (let i = 0; i < 5; i++) { const value = await read(); if (accept(value)) return value; } throw new Error('Not stable'); } };
  assert.deepEqual(await clickOriginPoint(harness, '.egd-codex-thread-home-new', options), { x: 35, y: 60 });
  assert.equal(reads, 4, 'Three stable hit snapshots plus one final stale check');
  assert.deepEqual(points, [{ x: 35, y: 60 }]); assert.equal(Object.isFrozen(points[0]), true);
  assert.equal(trace.length, 1); assert.equal(trace[0].completed, true);
  for (const script of scripts) assert.doesNotMatch(script, /scrollIntoView|\.click\(|\.focus\(|dispatchEvent|setAttribute\(|\.value\s*=/);
  for (const mode of ['moved-target', 'changed-room', 'occluded', 'input-failed']) {
    points.length = 0; trace.length = 0; reads = 0; let screenReads = 0;
    const changed = { ...harness,
      evaluateChrome: async () => ({ ...screen, ...(mode === 'changed-room' && ++screenReads > 6 ? { threadId: 'other' } : {}) }),
      clickPoint: async point => { points.push(point); if (mode === 'input-failed') throw new Error('native input uncertain'); } };
    await assert.rejects(clickOriginPoint(changed, '.egd-codex-thread-home-new', { ...options,
      observeTargets: async () => { reads++; const value = structuredClone(target);
        if (reads === 4 && mode === 'moved-target') value.rect.x++;
        if (reads === 4 && mode === 'occluded') value.hitCount = 8;
        return [value]; },
    }), mode === 'input-failed' ? /native input uncertain/ : /stale; no input or retry/);
    assert.equal(points.length, mode === 'input-failed' ? 1 : 0, mode);
    assert.equal(reads, 4, 'Never reacquire/retry after a stale final screen or failed input');
  }
});

test('origin verifier: native review binds full path and six real HTTP identity fields before any engine or Send work', () => {
  for (const status of ['none', 'connected']) {
    const { peer, view } = preparation(status);
    assert.equal(assertOriginRoomProjectReview(view, peer, initialRoom, status, status === 'connected' ? 1 : 0).expectedRoomProject.status, status);
  }
  for (const mutate of [
    pair => { pair.view.thread.id = 'other-ui-room'; }, pair => { pair.view.thread.clientThreadId = 'other-room'; },
    pair => { pair.view.thread.requestProjectTarget = { projectId: 'override' }; }, pair => { pair.view.thread.messages = 1; },
    pair => { pair.view.panelThreadId = 'stale-panel'; }, pair => { pair.view.summary.status = 'loading'; },
    pair => { pair.view.chip.count = 2; }, pair => { pair.view.chip.source = 'request'; },
    pair => { pair.view.effective.path = '/owned/orig…'; }, pair => { pair.view.effective.title = 'Board 상속 · Other'; },
    pair => { pair.view.effective.geometry.hits[4] = false; }, pair => { pair.view.effective.geometry.rect = rectangle(0, 5000); },
    pair => { pair.peer.preparedRoom = 'other-room'; }, pair => { pair.peer.fakeRpc.push({ method: 'thread/start' }); },
    pair => { pair.peer.persisted.requests = 1; }, pair => { pair.peer.requests.push({ path: '/chat/send' }); },
    pair => { pair.peer.requests[0].sequence = 1; }, pair => { pair.peer.requests[0].delegated = false; },
    pair => { pair.peer.requests[0].status = 409; }, pair => { pair.peer.requests[0].response.result.project.rootId = 'other-root'; },
    pair => { pair.peer.requests[0].response.result.project.projectId = 'other-project'; },
    pair => { pair.peer.requests[0].response.result.roomId = 'wrong-room'; },
    pair => { pair.peer.requests[0].response.result.source = 'room'; },
    pair => { pair.peer.requests[0].response.result.inheritance.boardId = CHAT_ORIGIN_FILE_BOARDS.other; },
    pair => { pair.peer.requests[0].response.result.override = { projectId: 'override' }; },
    pair => { pair.peer.requests[0].response.result.project.displayPath = '/other'; },
  ]) { const pair = preparation('connected'); mutate(pair); assert.throws(() => assertOriginRoomProjectReview(pair.view, pair.peer, initialRoom, 'connected', 1)); }
});

test('origin verifier: settles initial none then natively reopens Details after preparation, with no speculative Send or retry', async () => {
  const calls = [], scripts = [], samples = [];
  let prepared = false, opened = false, reread = false;
  const value = () => preparation(prepared ? 'connected' : 'none');
  const harness = { evaluateChrome: async script => { samples.push('ui'); scripts.push(script); const { view } = value(); view.panelCount = opened ? 1 : 0; return view; } };
  const reviewed = await prepareOriginRoomForSend(harness, initialRoom, {
    click: async selector => { calls.push(selector); opened = selector.includes('chat-project-open'); if (prepared && opened) reread = true; },
    state: async () => {
      samples.push('http');
      const { peer } = value();
      if (prepared && !reread) peer.requests = preparation().peer.requests;
      return peer;
    },
    prepareRoom: async id => { calls.push(`prepare:${id}`); prepared = true; },
    waitUntil: async (read, accept) => { const result = await read(); assert.equal(accept(result), true); return result; },
  });
  assert.deepEqual(calls, ['[data-testid="chat-project-open"]', '[data-testid="chat-project-cancel"]',
    `prepare:${initialRoom.clientThreadId}`, '[data-testid="chat-project-open"]', '[data-testid="chat-project-cancel"]']);
  assert.equal(reviewed.initial.expectedRoomProject.status, 'none');
  assert.equal(reviewed.reviewed.expectedRoomProject.rootId, 'original-root');
  assert.equal(reviewed.sendAttemptsBeforeReview, 0);
  assert.deepEqual(samples, ['ui', 'http', 'http', 'ui', 'http', 'ui', 'http'], 'A ready UI sample precedes its corresponding HTTP trace');
  for (const script of scripts) assert.doesNotMatch(script, /dispatchEvent|\.click\(|\.focus\(|setAttribute\(|\.value\s*=|\.open\s*=|fetch\(/);
});

test('origin verifier: import is inert and CLI accepts only explicit isolated headless bounded mode', async t => {
  const spies = [t.mock.method(net.Server.prototype, 'listen', () => assert.fail('No listener')),
    t.mock.method(net.Socket.prototype, 'connect', () => assert.fail('No browser connection on import')), t.mock.method(globalThis, 'fetch', () => assert.fail('No HTTP')),
    ...['spawn', 'spawnSync', 'execFile', 'execFileSync'].map(name => t.mock.method(childProcess, name, () => assert.fail('No process')))];
  await import(`./verify-firefox-mcp-chat-origin-file-flow.mjs?inert=${Date.now()}`);
  assert.equal(chatOriginFileOptions(argv, env, now).deadlineMs, now + 6 * 60_000);
  for (const patch of [{ MOZ_HEADLESS: '0' }, { EGDESK_QA_REAL_TURN: '1' }, { EGDESK_QA_FIXTURE_TOKEN: '' },
    { EGDESK_QA_PROJECT_FILE_FIXTURE: '1' }, { EGDESK_MARIONETTE_PORT: '2828' }, { EGDESK_QA_FIXTURE_PORT: '39218' }, { EGDESK_QA_FIXTURE_PORT: '2829' }]) {
    assert.throws(() => chatOriginFileOptions(argv, { ...env, ...patch }, now));
  }
  for (const args of [[], ['--profile', 'relative'], ['--profile', '/owned/profile', '--unknown', 'x'], ['--profile', '/owned/profile', '--profile', '/other'],
    ['--profile', '/owned/profile', '--deadline-utc', '2026-10-25T22:39:00Z'], ['--profile', '/owned/profile', '--deadline-utc', '2026-10-25T23:40:00Z']]) {
    assert.throws(() => chatOriginFileOptions(args, env, now));
  }
  for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
});

test('origin verifier: command selector binds all three opaque IDs without a first-row fallback', () => {
  assert.equal(originCommandSelector(original), '[data-testid="chat-command-result"][data-conversation-id="native-original"][data-run-id="run-original"][data-item-id="command-original"]');
  for (const key of ['conversationId', 'runId', 'itemId']) for (const value of [undefined, '', ' ', 'x'.repeat(301), 'bad\0id']) assert.throws(() => originCommandSelector({ ...original, [key]: value }));
});

test('origin verifier: rejects wrong peer/profile, fake origin binding, extra provider calls and uncounted effects', () => {
  const options = chatOriginFileOptions(argv, env, now);
  assert.equal(assertChatOriginFilePeer(state(), options), true);
  for (const mutate of [value => { value.profile = '/other'; }, value => { value.port = 39218; }, value => { value.kind = 'synthetic-mixed'; },
    value => { value.persisted.origins = []; }, value => { value.persisted.origins[0].project.startCwd = '/other'; },
    value => value.fakeRpc.push({ method: 'turn/start' }), value => { value.retainedOutputSha256 = 'changed'; },
    ...['providerTurns', 'shellExecutions', 'nativeProcessSpawns', 'nativePickerInvocations', 'approvalPosts', 'uiOriginalWrites', 'uiOriginalWriteAttempts', 'gitAttempts', 'nativeCreateAttempts'].map(key => value => { value.effects[key]++; })]) {
    const peer = state(); mutate(peer); assert.throws(() => assertChatOriginFilePeer(peer, options));
  }
});

test('origin verifier: exact original-root HTTP reads and one managed SQL write are distinct from source writes', () => {
  const { before, after } = windowPair();
  assert.deepEqual(assertOriginReadWindow(before, after), { fileId: 'current-file', draftId: 'real-draft', originReads: 2, managedDraftSqlWrites: 1 });
  for (const mutate of [value => { value.requests[0].query.itemId = original.itemId; }, value => { value.requests[0].query.runId = 'other'; },
    value => { value.requests[0].response.rootId = 'other-root'; }, value => { value.requests[2].request.rootId = 'other-root'; },
    value => { value.requests[2].request.path = 'source.test.js'; }, value => { value.requests[3].request.fileId = 'another-file'; },
    value => { value.requests[3].status = 404; }, value => { value.requests[3].delegated = false; },
    value => value.requests.push({ path: '/v1/files/projects/open', method: 'POST', status: 200, delegated: true }),
    value => { value.effects.uiOriginalWrites++; }, value => { value.effects.controlledSourceWrites++; },
    value => { value.effects.managedDraftSqlWrites = 0; }, value => { value.persisted.drafts = 0; },
    value => { value.retainedOutputSha256 = 'rewritten'; }, value => value.registrations.push({ rootId: 'fallback' }),
    value => value.fakeRpc.push({ method: 'turn/start' })]) {
    const pair = windowPair(); mutate(pair.after); assert.throws(() => assertOriginReadWindow(pair.before, pair.after));
  }
});

test('origin verifier: NEW CURRENT card retains original identity, old output and closed source Details', () => {
  const pair = views(), peer = state();
  assert.equal(assertCurrentOriginFileUi(pair.before, pair.after, peer, 'current-file', 'real-draft', initialRoom).id, 'egd-file-card-2');
  for (const mutate of [value => { value.command.identity.runId = 'other'; }, value => { value.command.tail = 'CURRENT'; },
    value => { value.thread.requestProjectTarget.projectId = 'original-project'; }, value => { value.cards[1].id = 'egd-file-card-1'; },
    value => { value.cards[1].snapshot.rootId = 'other-root'; }, value => { value.cards[1].snapshot.fileId = 'wrong-file'; },
    value => { value.cards[1].editor.value = CHAT_ORIGIN_FILE_TEXT.historic; }, value => { value.cards[1].busy = 'true'; },
    value => { value.cards[1].inert = true; }, value => { value.cards[1].notice.paragraphs[1].painted = false; },
    value => { value.cards[1].notice.paragraphs[0].painted = false; }, value => { value.cards[1].notice.details[0].open = true; },
    value => { value.cards[1].notice.details[0].text = 'unbound source'; }]) {
    const changed = views(); mutate(changed.after); assert.throws(() => assertCurrentOriginFileUi(changed.before, changed.after, peer, 'current-file', 'real-draft', initialRoom));
  }
  assert.equal(pair.after.cards[1].notice.paragraphs.length, 2, 'No obsolete requirement for four always-painted paragraphs');
});

test('origin verifier: extra other-Board lists, foreign drafts, repeated reads and changed receipts fail closed', () => {
  const draftRead = () => ({ path: '/v1/files/drafts/read', method: 'POST', status: 200, delegated: true, query: {}, request: { draftId: 'real-draft' },
    response: { result: { id: 'real-draft', rootId: 'original-root', fileId: 'current-file' } } });
  const positive = windowPair(); positive.after.requests.push(draftRead());
  assert.equal(assertOriginReadWindow(positive.before, positive.after).draftId, 'real-draft');
  for (const mutate of [
    value => value.requests.push({ ...structuredClone(value.requests[1]), request: { directoryId: 'other-directory', cursor: 0, limit: 100 } }),
    value => { value.requests[1].request.directoryId = 'other-directory'; },
    value => { value.requests[1].request.cursor = 1; },
    value => { const row = draftRead(); row.request.draftId = 'other-draft'; value.requests.push(row); },
    value => { const row = draftRead(); row.response.result.rootId = 'other-root'; value.requests.push(row); },
    value => { const row = draftRead(); row.response.result.fileId = 'other-file'; value.requests.push(row); },
    value => { const row = draftRead(); row.response.result.id = 'other-draft'; value.requests.push(row); },
    value => value.requests.push(draftRead(), draftRead()), value => value.requests.unshift(draftRead()),
    value => { value.requests[4].response.result.rootId = 'other-root'; },
    value => { value.requests[1].query.rootId = 'other-root'; },
    value => value.requests.push({ path: '/chat/history', method: 'GET', status: 200, delegated: true, query: { clientThreadId: 'other-room' } }),
  ]) { const pair = windowPair(); mutate(pair.after); assert.throws(() => assertOriginReadWindow(pair.before, pair.after)); }
});

test('origin verifier: same command IDs cannot hide a different active UI room, client room or conversation', () => {
  for (const side of ['before', 'after']) for (const key of ['id', 'clientThreadId', 'conversationId']) {
    const pair = views(); pair[side].thread[key] = `other-${key}`;
    assert.throws(() => assertCurrentOriginFileUi(pair.before, pair.after, state(), 'current-file', 'real-draft', initialRoom));
  }
  assert.throws(() => assertOriginActiveRoom(views().before, original, { ...initialRoom, id: 'other-initial-room' }));
  const pair = views(); pair.after.cards[1].snapshot.draftId = 'old-draft';
  assert.throws(() => assertCurrentOriginFileUi(pair.before, pair.after, state(), 'current-file', 'real-draft', initialRoom));
});

test('origin verifier: CURRENT at top 5000, ancestor clipping, occlusion or internal scroll is not visible', () => {
  assert.equal(originEditorVisible(readOriginEditorGeometry(editorNode())), true);
  for (const mutate of [
    node => { node.getBoundingClientRect = () => rectangle(20, 5000); },
    node => { node.parentElement = { style: { ...node.style, overflowY: 'hidden' }, offsetWidth: 800, offsetHeight: 80,
      clientWidth: 800, clientHeight: 80, clientLeft: 0, clientTop: 0, getBoundingClientRect: () => rectangle(0, 0, 800, 80) }; },
    node => { node.ownerDocument.elementFromPoint = () => ({ overlay: true }); },
    node => { let count = 0; node.ownerDocument.elementFromPoint = () => ++count === 5 ? {} : node; },
    node => { node.style.opacity = '0'; }, node => { node.scrollTop = 30; },
    node => { node.scrollLeft = 10; }, node => { node.scrollHeight = 500; }, node => { node.scrollWidth = 500; },
  ]) {
    const node = editorNode(); mutate(node); const geometry = readOriginEditorGeometry(node);
    assert.equal(originEditorVisible(geometry), false);
    const pair = views(); pair.after.cards[1].editor.geometry = geometry;
    assert.equal(pair.after.cards[1].editor.visible, true, 'A stale shallow shown=true must not bypass geometry');
    assert.throws(() => assertCurrentOriginFileUi(pair.before, pair.after, state(), 'current-file', 'real-draft', initialRoom));
  }
});

test('origin verifier: owned first-use observation handles no Browser and null fullscreen without false equality', async () => {
  for (const cardFullscreen of [null, undefined, { cardId: 'another-card', rect: {} }]) {
    const value = await observeOriginDesk({ evaluateChrome: script => runInNewContext(`(${script})()`, {
      window: { __egdesk: { state: { cardFullscreen }, surface: { snapshot: () => ({ browserCardId: null, initialBrowserFocus: false }) } } },
      document: { getElementById: () => assert.fail('No null-ID DOM lookup') },
    }) });
    assert.equal(value.fullscreen, false); assert.equal(value.cardId, null); assert.equal(value.browserContextId, null);
  }
});

test('origin verifier: observation is read-only and actions remain native; shared mutating room helper is not used', async () => {
  const scripts = [], expected = views().after;
  const observed = await observeChatOriginFileUi({ evaluateChrome: async script => { scripts.push(script); return expected; } }, original);
  assert.equal(observed, expected); assert.equal(scripts.length, 1);
  assert.match(scripts[0], /data-conversation-id/); assert.match(scripts[0], /_fileView\?\.snapshot/);
  assert.doesNotMatch(scripts[0], /dispatchEvent|\.click\(|\.focus\(|setAttribute\(|innerHTML\s*=|\.value\s*=|\.open\s*=|setStringPref/);
  const source = readFileSync(new URL('./verify-firefox-mcp-chat-origin-file-flow.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /newQaThread|\.title\s*=|dispatchEvent|\.style\.[a-zA-Z]+\s*=|\.hidden\s*=|setStringPref|createServer|\.listen\(/);
  assert.match(source, /await harness\.clickPoint\(point\)/); assert.match(source, /await harness\.press/);
  assert.doesNotMatch(clickOriginPoint.toString(), /harness\.click\(|uidFor|scrollIntoView|scrollWithKey|catch\s*\(/);
  assert.match(source, /originFileModuleProvenance\(options\.profile\)/);
  assert.equal((source.match(/await sendFromComposer\(/g) || []).length, 1, 'Exactly one Send, never a guard-bypassing retry');
  assert.ok(source.indexOf('result.originPreparation = await prepareOriginRoomForSend') < source.indexOf('await sendFromComposer('));
  const projectScripts = [];
  await observeOriginProjectUi({ evaluateChrome: async script => { projectScripts.push(script); return {}; } });
  assert.match(projectScripts[0], /chat-project-effective/);
  assert.doesNotMatch(projectScripts[0], /dispatchEvent|\.click\(|\.focus\(|setAttribute\(|innerHTML\s*=|\.value\s*=|\.open\s*=|fetch\(/);
  const factory = readFileSync(new URL('./egdesk-chat-origin-file-fixture.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(factory, /bindRunProjectOrigin\s*\(|INSERT INTO run_project_origins|new RunOutputStore|createServer|\.listen\(/,
    'No manually seeded origin DTO or parallel synthetic output store');
});

test('origin File observation reads the shown editor (CodeMirror when present, else textarea)', () => {
  const source = readFileSync(new URL('./verify-firefox-mcp-chat-origin-file-flow.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('readShownFileEditor(card)') && source.includes('file-code-editor'));
});
