import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as FileView from '../overlay/resources/EGDeskFileView.sys.mjs';
import * as FileCardState from '../overlay/resources/EGDeskFileCardState.sys.mjs';
import { createFileCardZone } from '../overlay/resources/surface/EGDeskSurfaceFileCard.mjs';
import { createChatRunResultView } from '../overlay/resources/EGDeskChatRunResult.sys.mjs';
import { createEGDeskFileHttpAdapter, EGDESK_FILE_ENDPOINTS } from '../helper/egdesk-file-http.mjs';
import { createChatHttpHandler } from '../helper/codex-bridge-http.mjs';

// Production DOM listeners + real File adapter/resolver and origin HTTP parser.
// No listener, provider, native picker, terminal, git process or original save.
class Element {
  constructor(document, tag) {
    this.ownerDocument = document; this.tagName = tag; this.children = []; this.parentElement = null;
    this.attributes = {}; this.listeners = new Map(); this.dataset = {}; this.style = {};
    this.className = ''; this.value = ''; this.hidden = false; this.disabled = false; this.scrollTop = 0;
    this.open = false; this.ownText = '';
  }
  set textContent(text) { this.replaceChildren(); this.ownText = String(text); }
  get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { assert.fail('No HTML interpretation'); }
  get isConnected() { return this === this.ownerDocument.body || !!this.parentElement?.isConnected; }
  append(...children) {
    for (const child of children) { if (child.parentElement) child.remove(); child.parentElement = this; this.children.push(child); }
  }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.ownText = ''; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key === 'id') this.id = String(value);
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(type, callback) { const listeners = this.listeners.get(type) || new Set(); listeners.add(callback); this.listeners.set(type, listeners); }
  removeEventListener(type, callback) { this.listeners.get(type)?.delete(callback); }
  matches(selector) {
    if (selector === '[hidden]') return this.hidden;
    const attr = /^\[([^=]+)="([^"]+)"\]$/.exec(selector);
    if (attr) return this.getAttribute(attr[1]) === attr[2];
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1));
    return this.tagName === selector;
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null; }
  contains(child) { for (let node = child; node; node = node.parentElement) if (node === this) return true; return false; }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  fire(type, properties = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() { this.stopped = true; }, ...properties }, pending = [];
    for (let node = this; node; node = node.parentElement) {
      for (const callback of node.listeners.get(type) || []) pending.push(callback(event));
      if (event.stopped) break;
    }
    return Promise.all(pending);
  }
  click() {
    if (this.disabled) return Promise.resolve();
    if (this.tagName === 'summary' && this.parentElement?.tagName === 'details') this.parentElement.open = !this.parentElement.open;
    return this.fire('click');
  }
}
const deferred = () => Promise.withResolvers();
const target = Object.freeze({ conversationId: 'origin-conversation', runId: 'origin-run', itemId: 'origin-command' });

async function harness(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-origin-file-')));
  const roots = [path.join(temp, 'original'), path.join(temp, 'other')];
  for (const root of roots) {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'source.test.js'), root === roots[0] ? 'current first\nCURRENT_SOURCE\ncurrent third\n' : 'OTHER_ROOT_PRIVATE\n');
  }
  const source = path.join(roots[0], 'source.test.js'), registrations = [], requests = [], originRequests = [];
  const effects = { boardReads: 0, pickers: 0, terminals: 0, network: 0, git: 0, provider: 0 };
  const hooks = { beforeFile: async () => {}, afterFile: async () => {}, beforeOrigin: async () => {}, origin: value => value };
  const makeAdapter = () => createEGDeskFileHttpAdapter({ draftDirectory: path.join(temp, 'drafts'), localOwnerScope: 'origin-local',
    resolveRootSelection: async ({ selectionId }) => roots[selectionId === 'pick-original' ? 0 : 1],
    onRootRegistered: value => registrations.push(value),
    gitReview: { status: async () => { effects.git++; assert.fail('origin open must not start git'); } } });
  let adapter = makeAdapter();
  const dispatch = async (name, body) => {
    const result = await adapter.dispatch({ method: 'POST', pathname: EGDESK_FILE_ENDPOINTS[name], body, ownerScope: 'origin-local' });
    assert.equal(result.status, 200, JSON.stringify(result.body)); return result.body.result;
  };
  const projects = [await dispatch('attachProject', { boardId: 'a', selectionId: 'pick-original' }),
    await dispatch('attachProject', { boardId: 'b', selectionId: 'pick-other' })];
  const workspace = await adapter.resolveProjectWorkspace({ ownerScope: 'origin-local', boardId: 'a' });
  const privateOrigin = { project: { projectId: workspace.projectId, source: 'board', fileOwnerScope: 'origin-local',
    startCwd: workspace.absolutePath, fsIdentity: workspace.identity } };
  const handler = createChatHttpHandler({ async runProjectOrigin(query) {
    if (query.conversationId !== target.conversationId || query.runId !== target.runId) return { protocolVersion: 1, ...query, status: 'unknown', verified: false };
    const result = await adapter.resolveRunProjectOrigin({ ownerScope: 'origin-local', origin: privateOrigin });
    return { protocolVersion: 1, ...query, ...result };
  } }, async () => { effects.provider++; assert.fail('no provider authentication'); });
  const readOrigin = async (selected, { signal } = {}) => {
    if (signal?.aborted) throw new Error('aborted');
    // The public HTTP route deliberately rejects itemId, paths and owner data.
    const query = { conversationId: selected.conversationId, runId: selected.runId };
    const url = new URL('/chat/run-project-origin?' + new URLSearchParams(query), 'http://unused.invalid');
    originRequests.push({ method: 'GET', query: Object.fromEntries(url.searchParams) });
    await hooks.beforeOrigin();
    if (signal?.aborted) throw new Error('aborted');
    const response = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    assert.equal(await handler({ method: 'GET' }, response, url), true);
    assert.equal(response.status, 200);
    return hooks.origin(response.body);
  };
  const document = { createElement: tag => new Element(document, tag), activeElement: null };
  document.body = document.createElement('body'); document.querySelector = selector => document.body.querySelector(selector);
  const createService = () => FileView.createEGDeskFileServiceCallbacks({ request: async (pathname, body) => {
    const name = Object.keys(EGDESK_FILE_ENDPOINTS).find(key => EGDESK_FILE_ENDPOINTS[key] === pathname);
    const request = { name, body: structuredClone(body) }; requests.push(request);
    await hooks.beforeFile(request);
    const response = await adapter.dispatch({ method: 'POST', pathname, body, ownerScope: 'origin-local' });
    await hooks.afterFile(request, response);
    return response.body;
  } });
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'data') Object.assign(node.dataset, value);
      else if (key === 'style') Object.assign(node.style, value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'hidden' || key === 'id') node[key] = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) if (typeof child === 'string') node.ownText += child; else if (child) node.append(child);
    return node;
  };
  const globals = { document, window: { AbortController, setTimeout, clearTimeout },
    ChromeUtils: { importESModule: () => ({ ...FileView, createEGDeskFileServiceCallbacks: createService,
      createEGDeskNativeFilePickers: () => ({ chooseRoot() { effects.pickers++; assert.fail('no picker'); } }) }) },
    fetch: () => { effects.network++; assert.fail('no network listener or fetch'); } };
  const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  let sequence = 0, epoch = 0;
  const zone = createFileCardZone({ FileCardState, allocCardSeq: () => ++sequence, boardNotice() {}, chatBindingNonce: () => String(sequence),
    chatInputSourceForView() {}, cloneJson: structuredClone, el, focusCanvasCard() {}, getCodexThreadById() {},
    getProjectTarget: () => { effects.boardReads++; return { boardId: 'b', title: 'Wrong active Board' }; },
    markAgendaDirty() {}, openChatInputPanel() {}, resolveCanvasCardPlacement: () => ({ x: 0, y: 0, width: 600, height: 400 }), revealPlacedCanvasCard() {},
    spawnDeskWindowShell: options => {
      const root = el('article', { class: options.className, id: options.id }), identity = el('header'), actions = el('nav'), content = el('main');
      root.append(identity, actions, content); document.body.append(root); return { root, slots: { identity, actions, content } };
    },
    spawnTerminalCard: () => { effects.terminals++; assert.fail('no terminal'); }, state: { codex: {} },
  });
  t.after(async () => {
    for (const card of document.body.querySelectorAll('.egd-file-card')) await card._fileView?.close();
    await adapter.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
    await fs.rm(temp, { recursive: true, force: true });
  });
  const location = { path: source, relativePath: 'source.test.js', line: 2, column: 3, inProject: true };
  const current = () => { const captured = epoch; return ids => captured === epoch && Object.keys(target).every(key => ids?.[key] === target[key]); };
  const open = (patch = {}) => zone.openVerifiedRunFile({ target, location, readOrigin, isCurrent: current(), ...patch });
  return { source, roots, projects, document, zone, readOrigin, requests, originRequests, registrations, effects, hooks, location, open, createService, current,
    changeEpoch: () => epoch++, dispatch, cards: () => document.body.querySelectorAll('.egd-file-card'),
    restart: async () => { await adapter.close(); adapter = makeAdapter(); } };
}

function assertReadEffects(h, { drafts = 0, boardReads = 0 } = {}) {
  assert.deepEqual(h.effects, { boardReads, pickers: 0, terminals: 0, network: 0, git: 0, provider: 0 });
  const allowed = new Set(['listDirectory', 'resolvePath', 'readFile', 'createDraft', 'readDraft']);
  assert.ok(h.requests.every(request => allowed.has(request.name)), 'no registration, project-open, original save, execution or approval');
  assert.equal(h.requests.filter(request => request.name === 'createDraft').length, drafts, 'managed working-copy creation is counted separately');
  assert.ok(h.originRequests.every(request => request.method === 'GET' && JSON.stringify(request.query) === JSON.stringify({ conversationId: target.conversationId, runId: target.runId })));
}

test('retained command -> explicit current file -> a separate production File Card through real origin and File services', async t => {
  const h = await harness(t), existing = h.zone.spawnFileCard();
  await existing._fileReady;
  const registrationCount = h.registrations.length, boardReads = h.effects.boardReads;
  const retained = 'FAIL source.test.js\n  ● past failing test\n\n    Expected: old\n    Received: different\n\n      at fixture (source.test.js:2:3)\n\nTests: 1 failed, 1 total\n';
  let outputReads = 0;
  const chat = createChatRunResultView({ document: h.document, run: target,
    activity: { id: target.itemId, kind: 'commandExecution', status: 'failed', detail: { command: 'npm test', cwd: h.roots[0], exitCode: 1 } },
    fetchJson: async () => { outputReads++; return { protocolVersion: 1, ...target, head: '', tail: retained, totalBytes: retained.length, omittedBytes: 0, complete: true }; },
    isCurrent: h.current(), readOrigin: h.readOrigin, onOpenVerifiedFile: h.zone.openVerifiedRunFile });
  h.document.body.append(chat.element); t.after(() => chat.dispose());
  assert.equal(h.originRequests.length, 0);
  await chat.element.querySelector('button').click();
  assert.equal(h.cards().length, 1, 'reading output alone creates no File Card');
  const outputBefore = chat.element.querySelector('.egdesk-run-result-tail').textContent;
  const link = chat.element.querySelector('.egdesk-run-result-location');
  assert.match(link.textContent, /^현재 파일 열기 · /);
  const beforeClick = h.originRequests.length;
  await link.click();
  assert.ok(h.originRequests.length > beforeClick, 'click revalidates origin; the render-time DTO is not an opening grant');
  const cards = h.cards(), current = cards[1];
  assert.equal(cards.length, 2); assert.equal(cards[0], existing);
  assert.equal(existing._fileView.snapshot().fileId, null);
  assert.equal(current._fileView.snapshot().rootId, h.projects[0].rootId);
  assert.equal(current.querySelector('.egd-file-card-state').textContent, '현재 파일');
  assert.match(current.querySelector('.egdesk-file-editor').value, /CURRENT_SOURCE/);
  const notice = current.querySelector('.egd-file-card-notice');
  assert.equal(notice.hidden, false);
  for (const value of [target.runId, target.conversationId, target.itemId, h.source, '당시 행 참조', '당시 내용과 다를 수 있습니다']) assert.ok(notice.textContent.includes(value));
  assert.equal(chat.element.querySelector('.egdesk-run-result-tail').textContent, outputBefore);
  assert.equal(outputReads, 1); assert.equal(h.registrations.length, registrationCount);
  assertReadEffects(h, { drafts: 1, boardReads });
  assert.match(await fs.readFile(h.source, 'utf8'), /CURRENT_SOURCE/);
  await link.click();
  assert.equal(h.cards().length, 3, 'a later explicit click also does not reuse a preexisting Card');
  assertReadEffects(h, { drafts: 2, boardReads });
});

test('origin presentation keeps raw identities in native source details closed by default without extra actions', async t => {
  const h = await harness(t);
  assert.equal((await h.open()).status, 'opened');
  const card = h.cards()[0], notice = card.querySelector('.egd-file-card-notice'), details = notice.querySelector('details');
  assert.ok(details); assert.equal(details.open, false); assert.equal(details.getAttribute('open'), null);
  assert.equal(details.querySelector('summary').textContent, '출처 상세');
  const defaultText = notice.children.filter(child => child !== details).map(child => child.textContent).join('\n');
  assert.equal(notice.children.filter(child => child.tagName === 'p').length, 2);
  for (const id of Object.values(target)) {
    assert.ok(details.textContent.includes(id), 'original identity remains available inside details');
    assert.equal(defaultText.includes(id), false, 'raw identity does not occupy the default notice');
  }
  const requestCount = h.requests.length, originCount = h.originRequests.length, before = card._fileView.snapshot();
  await details.querySelector('summary').click(); assert.equal(details.open, true);
  await details.querySelector('summary').click(); assert.equal(details.open, false);
  assert.deepEqual(card._fileView.snapshot(), before);
  assert.equal(h.requests.length, requestCount); assert.equal(h.originRequests.length, originCount);
  assertReadEffects(h, { drafts: 1 });
});

test('origin presentation states current content briefly and distinguishes the historical line and column', async t => {
  const h = await harness(t);
  assert.equal((await h.open()).status, 'opened');
  const card = h.cards()[0], notice = card.querySelector('.egd-file-card-notice'), details = notice.querySelector('details');
  assert.equal(notice.hidden, false);
  assert.equal(card.querySelector('.egd-file-card-state').textContent, '현재 파일');
  assert.equal(notice.children[0].textContent, '현재 파일 · 이전 실행의 출력에서 열었습니다. 당시 내용과 다를 수 있습니다.');
  assert.ok(details.children.some(child => child.textContent === '당시 행 참조 · 2행 3열. 현재 파일의 행·열과 일치하지 않을 수 있습니다.'));
  assertReadEffects(h, { drafts: 1 });
});

test('origin presentation exposes the entire long target path as wrapping text outside collapsed details', async t => {
  const h = await harness(t), source = path.join(h.roots[0], 'long-current-source-'.repeat(8) + 'test.js');
  await fs.writeFile(source, 'current long-path fixture\n');
  assert.equal((await h.open({ location: { ...h.location, path: source } })).status, 'opened');
  const notice = h.cards()[0].querySelector('.egd-file-card-notice');
  const pathLine = notice.children.find(child => child.tagName === 'p' && child.textContent === `경로 · ${source}`);
  assert.ok(pathLine, 'full absolute path is visible text, not only a tooltip or collapsed metadata');
  assert.equal(notice.hidden, false); assert.equal(pathLine.hidden, false);
  assert.equal(notice.style.overflowWrap, 'anywhere');
  assert.equal(notice.querySelector('details').open, false);
  assertReadEffects(h, { drafts: 1 });
});

test('wrong/unknown original run and malformed verified DTOs cannot create a File Card', async t => {
  const h = await harness(t);
  for (const patch of [{ verified: false }, { status: 'unknown' }, { protocolVersion: 2 }, { conversationId: 'foreign' },
    { runId: 'foreign' }, { rootId: '' }, { directoryId: '' }, { projectId: '' }, { displayPath: 'relative' }]) {
    h.hooks.origin = origin => ({ ...origin, ...patch });
    assert.equal((await h.open()).status, 'unavailable');
  }
  h.hooks.origin = value => value;
  assert.equal((await h.open({ target: { ...target, runId: 'missing' }, isCurrent: () => true })).status, 'unavailable');
  assert.equal(h.cards().length, 0); assert.equal(h.requests.length, 0);
  assert.equal(h.effects.provider, 0);
});

for (const kind of ['outside', 'symlink-outside', 'symlink-inside', 'missing']) {
  test('real File resolver rejects ' + kind + ' without reinterpreting a forged relativePath', async t => {
    const h = await harness(t), registrationCount = h.registrations.length;
    let requested = path.join(h.roots[1], 'source.test.js');
    if (kind.startsWith('symlink')) {
      requested = path.join(h.roots[0], 'alias.test.js');
      await fs.symlink(kind === 'symlink-inside' ? h.source : path.join(h.roots[1], 'source.test.js'), requested);
    } else if (kind === 'missing') requested = path.join(h.roots[0], 'absent.test.js');
    const result = await h.open({ location: { ...h.location, path: requested, relativePath: 'source.test.js' } });
    assert.equal(result.status, 'unavailable');
    assert.equal(h.requests.find(request => request.name === 'resolvePath').body.path, requested);
    assert.equal(h.requests.some(request => request.name === 'readFile'), false);
    assert.equal(h.cards()[0].querySelector('.egdesk-file-editor'), null);
    assert.equal(h.registrations.length, registrationCount); assertReadEffects(h);
  });
}

for (const phase of ['listDirectory', 'resolvePath', 'readFile', 'createDraft']) {
  test('account/view A -> B -> A during ' + phase + ' cannot publish late file content', async t => {
    const h = await harness(t), entered = deferred(), release = deferred();
    h.hooks.afterFile = async request => { if (request.name === phase) { entered.resolve(); await release.promise; } };
    const opening = h.open(); await entered.promise;
    h.changeEpoch(); h.changeEpoch(); release.resolve();
    assert.equal((await opening).status, 'stale');
    assert.equal(h.cards()[0].querySelector('.egdesk-file-editor'), null);
    assertReadEffects(h, { drafts: phase === 'createDraft' ? 1 : 0 });
    assert.equal(h.requests.some(request => request.name === 'readFile'), ['readFile', 'createDraft'].includes(phase));
  });
}

for (const phase of ['listDirectory', 'resolvePath', 'readFile', 'createDraft']) {
  test('late rejected ' + phase + ' stays stale and cannot expose a transport error or continue the opening', async t => {
    const h = await harness(t);
    h.hooks.afterFile = async request => {
      if (request.name === phase) { h.changeEpoch(); throw new Error('PRIVATE_LATE_TRANSPORT_FAILURE'); }
    };
    assert.equal((await h.open()).status, 'stale');
    assert.equal(h.cards()[0].querySelector('.egdesk-file-editor'), null);
    assert.doesNotMatch(h.cards()[0].textContent, /PRIVATE_LATE_TRANSPORT_FAILURE|CURRENT_SOURCE/);
    assert.equal(h.requests.at(-1).name, phase);
    assertReadEffects(h, { drafts: phase === 'createDraft' ? 1 : 0 });
  });
}

test('caller mutation cannot replace the captured run, item or absolute location during origin verification', async t => {
  const h = await harness(t), entered = deferred(), release = deferred();
  const mutableTarget = { ...target }, mutableLocation = { ...h.location };
  let reads = 0;
  h.hooks.beforeOrigin = async () => { if (++reads === 1) { entered.resolve(); await release.promise; } };
  const opening = h.open({ target: mutableTarget, location: mutableLocation }); await entered.promise;
  Object.assign(mutableTarget, { conversationId: 'later-room', runId: 'later-run', itemId: 'later-item' });
  Object.assign(mutableLocation, { path: path.join(h.roots[1], 'source.test.js'), line: 999 });
  release.resolve();
  assert.equal((await opening).status, 'opened');
  assert.equal(h.requests.find(request => request.name === 'resolvePath').body.path, h.source);
  assert.match(h.cards()[0].querySelector('.egd-file-card-notice').textContent, /당시 행 참조 · 2행/);
  assertReadEffects(h, { drafts: 1 });
});

test('a caller cannot inject a previously verified-looking Card opening instead of a live origin read', async t => {
  const h = await harness(t);
  assert.throws(() => h.zone.spawnFileCard({ openMode: 'new', verifiedRunOpen: {
    target, location: h.location, origin: h.projects[0], current: () => true, verify: async () => {},
  } }), /확인된 실행 파일 요청/);
  assert.equal(h.cards().length, 0); assert.equal(h.originRequests.length, 0); assertReadEffects(h);
});

test('a current binary file uses the real read-only File state without creating a managed text copy', async t => {
  const h = await harness(t);
  await fs.writeFile(h.source, Buffer.from([0, 1, 2, 255, 10]));
  assert.equal((await h.open({ location: { ...h.location, line: 999 } })).status, 'opened');
  const card = h.cards()[0];
  assert.equal(card.querySelector('.egd-file-card-state').textContent, '현재 파일');
  assert.equal(card._fileView.snapshot().draftId, null);
  assert.equal(card.querySelector('.egdesk-file-editor-label').hidden, true);
  assert.match(card.querySelector('.egdesk-file-viewer').textContent, /이 형식은 편집할 수 없습니다/);
  assert.match(card.querySelector('.egd-file-card-notice').textContent, /당시 행 참조 · 999행/);
  assertReadEffects(h);
});

test('pending origin reads honor abort and cannot create a late Card', async t => {
  const h = await harness(t), entered = deferred(), release = deferred(), controller = new AbortController();
  h.hooks.beforeOrigin = async () => { entered.resolve(); await release.promise; };
  const opening = h.open({ signal: controller.signal }); await entered.promise; controller.abort(); release.resolve();
  assert.equal((await opening).status, 'stale'); assert.equal(h.cards().length, 0); assertReadEffects(h);
});

test('closing a Card during its ready promise invalidates the in-flight opening before dispose awaits readiness', async t => {
  const h = await harness(t), entered = deferred(), release = deferred();
  h.hooks.afterFile = async request => { if (request.name === 'resolvePath') { entered.resolve(); await release.promise; } };
  const opening = h.open(); await entered.promise;
  const closing = h.cards()[0]._beforeClose(); release.resolve();
  assert.equal((await opening).status, 'stale'); assert.equal(await closing, true);
  assert.equal(h.cards()[0].querySelector('.egdesk-file-editor'), null); assertReadEffects(h);
});

test('a real project detach during a File read invalidates its cached handle before any content is released', async t => {
  const h = await harness(t);
  h.hooks.afterFile = async request => { if (request.name === 'readFile') await h.dispatch('detachProject', { boardId: 'a' }); };
  assert.equal((await h.open()).status, 'unavailable');
  assert.equal(h.cards()[0].querySelector('.egdesk-file-editor'), null); assertReadEffects(h);
});

test('adapter restart without a current connection cannot turn retained origin into permission registration', async t => {
  const h = await harness(t), verified = await h.readOrigin(target), registrationCount = h.registrations.length;
  assert.equal(verified.verified, true); await h.restart();
  assert.equal((await h.open()).status, 'unavailable');
  assert.equal(h.cards().length, 0); assert.equal(h.requests.length, 0);
  assert.equal(h.registrations.length, registrationCount); assertReadEffects(h);
});

test('replacing the original root inode is rejected even if an identically named current file exists', async t => {
  const h = await harness(t), registrationCount = h.registrations.length;
  await fs.rename(h.roots[0], h.roots[0] + '-old'); await fs.mkdir(h.roots[0]);
  await fs.writeFile(h.source, 'REPLACEMENT_PRIVATE\n');
  assert.equal((await h.open()).status, 'unavailable');
  assert.equal(h.cards().length, 0); assert.equal(h.registrations.length, registrationCount); assertReadEffects(h);
});

test('source bytes changed between exact read and working-copy creation never display mismatched metadata/content', async t => {
  const h = await harness(t);
  h.hooks.afterFile = async request => { if (request.name === 'readFile') await fs.writeFile(h.source, 'external newer bytes\n'); };
  assert.equal((await h.open()).status, 'unavailable');
  assert.equal(h.cards()[0].querySelector('.egdesk-file-editor'), null);
  assertReadEffects(h, { drafts: 1 });
  assert.equal(await fs.readFile(h.source, 'utf8'), 'external newer bytes\n', 'only the simulated external edit changed the original');
});

test('root switches during path resolution cannot be overwritten by a late openFile token', async t => {
  const h = await harness(t), entered = deferred(), release = deferred();
  h.hooks.afterFile = async request => { if (request.name === 'resolvePath') { entered.resolve(); await release.promise; } };
  const opening = h.open(); await entered.promise;
  const card = h.cards()[0];
  await card._fileView.openRoot(h.projects[1], { scope: { rootId: h.projects[1].rootId, isCurrent: () => true } });
  await card._fileView.openRoot(h.projects[0], { scope: { rootId: h.projects[0].rootId, isCurrent: () => true } });
  release.resolve();
  assert.equal((await opening).status, 'unavailable');
  assert.equal(h.requests.some(request => request.name === 'readFile'), false);
  assert.equal(card.querySelector('.egdesk-file-editor'), null); assertReadEffects(h);
});

test('FileView checks the supplied generation after restored-draft reads before requesting any source file', async t => {
  const h = await harness(t), service = h.createService();
  const found = await service.resolvePath({ rootId: h.projects[0].rootId, path: h.source });
  const draft = await service.createDraft({ fileId: found.id });
  const view = FileView.createEGDeskFileView({ document: h.document, service }); h.document.body.append(view.element);
  t.after(() => view.close());
  let live = true;
  const scope = { rootId: h.projects[0].rootId, isCurrent: () => live };
  await view.openRoot(h.projects[0], { scope }); h.requests.length = 0;
  h.hooks.afterFile = async request => { if (request.name === 'readDraft') live = false; };
  assert.equal(await view.openFile(found.id, draft.id, { scope }), false);
  assert.deepEqual(h.requests.map(request => request.name), ['readDraft']);
  assert.equal(view.snapshot().fileId, null);
});

test('a scoped current-file read cannot fall back to a saved draft when its original is unavailable', async t => {
  const h = await harness(t), service = h.createService();
  const found = await service.resolvePath({ rootId: h.projects[0].rootId, path: h.source });
  const draft = await service.createDraft({ fileId: found.id });
  const view = FileView.createEGDeskFileView({ document: h.document, service }); h.document.body.append(view.element);
  t.after(() => view.close());
  const scope = { rootId: h.projects[0].rootId, isCurrent: () => true };
  await view.openRoot(h.projects[0], { scope });
  await fs.unlink(h.source); // Simulate an external removal of this temporary fixture, not a File action.
  h.requests.length = 0;
  await assert.rejects(view.openFile(found.id, draft.id, { scope }));
  assert.equal(view.snapshot().fileId, null); assert.equal(view.snapshot().draftId, null);
  assert.deepEqual(h.requests.map(request => request.name), ['readDraft', 'readFile']);
  assert.match((await service.readDraft({ draftId: draft.id })).text, /CURRENT_SOURCE/, 'the separately retained working copy remains intact');
});

test('live provenance is cleared when a later explicit file selection changes the File target', async t => {
  const h = await harness(t);
  assert.equal((await h.open()).status, 'opened');
  const card = h.cards()[0], previous = card._fileView.snapshot();
  await fs.writeFile(path.join(h.roots[0], 'another.txt'), 'another current file\n');
  await card._fileView.openAt({ path: path.join(h.roots[0], 'another.txt') });
  assert.notEqual(card._fileView.snapshot().fileId, previous.fileId);
  assert.equal(card.querySelector('.egd-file-card-notice').hidden, true);
  assert.equal(card.querySelector('.egd-file-card-state').textContent, '파일');
  assertReadEffects(h, { drafts: 2 });
});

test('a changed current-origin handle after a service await cannot retarget the same click to another authorized root', async t => {
  const h = await harness(t);
  let reads = 0;
  h.hooks.origin = value => ++reads === 1 ? value : { ...value, rootId: h.projects[1].rootId, directoryId: h.projects[1].directoryId, displayPath: h.projects[1].displayPath };
  assert.equal((await h.open()).status, 'unavailable');
  assert.equal(h.requests.some(request => request.name === 'resolvePath' || request.name === 'readFile'), false);
  assert.equal(h.cards()[0].querySelector('.egdesk-file-tree'), null);
  assertReadEffects(h);
});

test('a source epoch lost during the post-list origin verification cannot release the pending tree', async t => {
  const h = await harness(t), entered = deferred(), release = deferred();
  let reads = 0;
  h.hooks.beforeOrigin = async () => { if (++reads === 2) { entered.resolve(); await release.promise; } };
  const opening = h.open(); await entered.promise;
  h.changeEpoch(); release.resolve();
  assert.equal((await opening).status, 'stale');
  assert.equal(h.cards()[0].querySelector('.egdesk-file-tree'), null);
  assertReadEffects(h);
});

test('an origin scope cannot resolve against a different FileView root', async t => {
  const h = await harness(t), view = FileView.createEGDeskFileView({ document: h.document, service: h.createService() });
  h.document.body.append(view.element); t.after(() => view.close());
  await view.openRoot(h.projects[1], { scope: { rootId: h.projects[1].rootId, isCurrent: () => true } });
  h.requests.length = 0;
  assert.equal(await view.openAt(h.location, { scope: { rootId: h.projects[0].rootId, isCurrent: () => true } }), false);
  assert.equal(h.requests.length, 0);
});

test('ordinary directory loading survives a newer file selection while an original-run opening cannot re-arm after a flush', async t => {
  const h = await harness(t), service = h.createService(), view = FileView.createEGDeskFileView({ document: h.document, service });
  h.document.body.append(view.element); t.after(() => view.close());
  // Ordinary users retain the preexisting independent tree population behavior.
  service.gitStatus = async () => ({ available: false });
  const found = await service.resolvePath({ rootId: h.projects[0].rootId, path: h.source });
  const listed = deferred(), releaseList = deferred();
  h.hooks.afterFile = async request => { if (request.name === 'listDirectory') { listed.resolve(); await releaseList.promise; } };
  const rootOpening = view.openRoot(h.projects[0]); await listed.promise;
  await view.openFile(found.id); releaseList.resolve(); await rootOpening;
  assert.equal(view.element.querySelectorAll('[role="treeitem"]').length, 1);
  h.hooks.afterFile = async () => {};
  const editor = view.element.querySelector('.egdesk-file-editor'); editor.value = 'managed draft only';
  const updating = deferred(), releaseUpdate = deferred();
  h.hooks.afterFile = async request => { if (request.name === 'updateDraft') { updating.resolve(); await releaseUpdate.promise; } };
  let live = true;
  const opening = view.openRoot(h.projects[1], { scope: { rootId: h.projects[1].rootId, isCurrent: () => live } });
  await updating.promise; live = false; releaseUpdate.resolve();
  assert.equal(await opening, false);
  assert.equal(view.snapshot().rootId, h.projects[0].rootId);
  assert.equal(editor.value, 'managed draft only');
  assert.match(await fs.readFile(h.source, 'utf8'), /CURRENT_SOURCE/, 'flushing only updated the managed working copy');
});
