import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as FileView from '../overlay/resources/EGDeskFileView.sys.mjs';
import * as FileCardState from '../overlay/resources/EGDeskFileCardState.sys.mjs';
import * as RunResult from '../overlay/resources/EGDeskRunResult.sys.mjs';
import { createFileCardZone } from '../overlay/resources/surface/EGDeskSurfaceFileCard.mjs';
import { normalizeProjectScripts } from '../helper/egdesk-project-store.mjs';
import { createEGDeskFileHttpAdapter } from '../helper/egdesk-file-http.mjs';

// Unit DOM dispatches the real production listeners. No copied click logic or
// browser/provider/OS process is involved; Main owns actual headless acceptance.
class Element {
  constructor(document, tag) {
    this.ownerDocument = document; this.tagName = tag; this.children = []; this.parentElement = null;
    this.attributes = {}; this.listeners = new Map(); this.dataset = {}; this.style = {};
    this.className = ''; this.value = ''; this.hidden = false; this.disabled = false; this.scrollTop = 0;
  }
  set textContent(text) { this.text = String(text); this.replaceChildren(); }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('No HTML interpretation'); }
  get isConnected() { return this === this.ownerDocument.body || !!this.parentElement?.isConnected; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  setAttribute(key, value) {
    this.attributes[key] = String(value);
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener(type, callback) { const listeners = this.listeners.get(type) || []; listeners.push(callback); this.listeners.set(type, listeners); }
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
  fire(type, properties = {}) {
    const event = { type, target: this, preventDefault() {}, stopPropagation() { this.stopped = true; }, ...properties };
    for (let node = this; node; node = node.parentElement) {
      for (const callback of node.listeners.get(type) || []) callback(event);
      if (event.stopped) break;
    }
  }
  click() { if (!this.disabled) this.fire('click'); }
}
function fakeDocument() {
  const document = { createElement: tag => new Element(document, tag), activeElement: null };
  document.body = document.createElement('body');
  document.querySelector = selector => document.body.querySelector(selector);
  return document;
}
const settle = async (turns = 3) => { for (let index = 0; index < turns; index++) await new Promise(resolve => setImmediate(resolve)); };
const until = async predicate => { const end = Date.now() + 3000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(predicate(), 'bounded UI operation completed'); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const project = (suffix = 'a', scripts = []) => ({ projectId: `project-${suffix}`, rootId: `root-${suffix}`, directoryId: `dir-${suffix}`,
  title: `보드 ${suffix}`, status: 'connected', displayPath: `/verified/${suffix}`, scripts: structuredClone(scripts), saveAsAvailable: true });
const typed = { id: 'test', name: '직접 검사', command: 'npm test', kind: 'test' };

function fakeService() {
  const projects = new Map(), drafts = new Map(), calls = [];
  let revision = 0;
  const service = {
    listDirectory: async ({ directoryId }) => ({ entries: [{ id: `file-${directoryId}`, name: 'source.txt', kind: 'file' }], nextCursor: null }),
    search: async () => ({ matches: [], truncated: false }),
    readFile: async ({ fileId }) => ({ id: fileId, name: 'source.txt', size: 5, sha256: 'a'.repeat(64), diskRevision: 'source-0', kind: 'text', text: 'start' }),
    createDraft: async ({ fileId }) => {
      const id = `draft-${fileId}`;
      if (!drafts.has(id)) drafts.set(id, { id, fileId, rootId: fileId.startsWith('file-dir-') ? `root-${fileId.slice('file-dir-'.length)}` : 'ordinary', name: 'source.txt', head: 'h0', text: 'start', baseText: 'start',
        bufferRevision: 0, savedRevision: 0, sourceHash: 'a'.repeat(64), sourceRevision: 'source-0', saveAsAvailable: true });
      return { ...drafts.get(id) };
    },
    readDraft: async ({ draftId }) => ({ ...drafts.get(draftId) }),
    updateDraft: async ({ draftId, text }) => { const draft = { ...drafts.get(draftId), text, head: `h${++revision}`, bufferRevision: revision }; drafts.set(draftId, draft); return { ...draft }; },
    saveDraft: async ({ draftId }) => { const draft = drafts.get(draftId); draft.savedRevision = draft.bufferRevision; return { draft: { ...draft }, receipt: { savedRevision: draft.savedRevision } }; },
    saveAs: async () => ({}), diffDraft: async () => ({ hunks: [] }),
    openProject: async ({ boardId }) => { calls.push(['open', boardId]); return { project: structuredClone(projects.get(boardId) || null) }; },
    setProjectScripts: async ({ projectId, scripts }) => {
      calls.push(['scripts', projectId, structuredClone(scripts)]);
      const stored = [...projects.values()].find(item => item.projectId === projectId);
      stored.scripts = normalizeProjectScripts(scripts);
      return { projectId, scripts: structuredClone(stored.scripts) };
    },
    openPickerChannel: async () => ({ token: 'channel', expiresAt: Date.now() + 60000 }),
    beginPicker: async ({ purpose }) => { calls.push(['begin', purpose]); return { requestId: 'picker' }; },
    completePicker: async request => { calls.push(['complete', request]); return request.cancelled ? { cancelled: true } : { selectionId: 'selected' }; },
    registerRoot: async () => { calls.push(['root']); return { rootId: 'ordinary', directoryId: 'ordinary-dir', name: '일반 폴더', displayPath: '/ordinary' }; },
    attachProject: async ({ boardId, title }) => { calls.push(['attach', boardId, title]); const value = { ...project(boardId.at(-1)), title }; projects.set(boardId, value); return value; },
  };
  return { service, projects, calls, drafts };
}
function viewFixture(t, options = {}) {
  const h = fakeService(), document = fakeDocument();
  const view = FileView.createEGDeskFileView({ document, service: h.service, parts: { runResult: RunResult }, ...options });
  document.body.append(view.element); t.after(() => view.close());
  return { ...h, document, view, find: selector => view.element.querySelector(selector) };
}

test('actual project button captures the Board before awaits and ordinary folder action remains ordinary', async t => {
  const chosen = deferred(), received = [];
  let target = { boardId: 'board-a', title: 'A' };
  const h = viewFixture(t, { getProjectTarget: () => target, chooseProject: value => { received.push(value); return chosen.promise; },
    chooseRoot: async () => ({ rootId: 'ordinary', directoryId: 'ordinary-dir' }) });
  h.find('.egdesk-file-project-connect').click();
  target.boardId = 'board-b'; target.title = 'B';
  assert.deepEqual(received, [{ boardId: 'board-a', title: 'A' }]);
  assert.match(h.find('.egdesk-file-project-connect').textContent, /A/);
  chosen.resolve(project()); await settle();
  assert.equal(h.view.snapshot().projectId, 'project-a');
  h.find('.egdesk-file-connect').click(); await settle();
  assert.equal(h.view.snapshot().projectId, null); assert.equal(h.view.snapshot().rootId, 'ordinary');
});

test('File toolbar wraps logical groups without wrapping short labels and retains the full project target', async t => {
  const longTitle = '긴 보드 이름 '.repeat(40);
  const chosen = [];
  const h = viewFixture(t, { chooseRoot: async () => null, getProjectTarget: () => ({ boardId: 'board-a', title: longTitle }),
    chooseProject: async target => { chosen.push(target); return { ...project(), title: longTitle }; } });
  const style = selector => h.find(selector).getAttribute('style');
  assert.deepEqual(h.find('.egdesk-file-toolbar').children.map(node => node.className),
    ['egdesk-file-connections', 'egdesk-file-project-actions', 'egdesk-file-search']);
  assert.match(style('.egdesk-file-toolbar'), /flex-wrap: wrap/);
  for (const selector of ['.egdesk-file-connect', '.egdesk-file-script-settings-button', '.egdesk-file-project-check', '.egdesk-file-search-mode', '.egdesk-file-search-button', '.egdesk-file-search-label-text']) {
    assert.match(style(selector), /white-space: nowrap/);
  }
  assert.match(style('.egdesk-file-search'), /flex-wrap: wrap/);
  assert.match(style('.egdesk-file-search-input'), /min-width: 4rem/);
  assert.match(style('.egdesk-file-project-connect-label'), /flex: 0 0 auto/);
  assert.match(style('.egdesk-file-project-target'), /text-overflow: ellipsis/);
  const connect = h.find('.egdesk-file-project-connect');
  assert.ok(connect.title.includes(longTitle)); assert.ok(connect.getAttribute('aria-label').includes(longTitle));
  assert.equal(h.find('.egdesk-file-project-actions').hidden, true);
  connect.click(); await settle();
  assert.equal(chosen[0].title, longTitle, 'layout truncation never truncates the captured Board identity');
  assert.equal(h.find('.egdesk-file-title').title, longTitle);
  assert.equal(h.find('.egdesk-file-project-actions').hidden, false);
});

test('command settings have a full-width command row and a bounded scroll area separate from reachable actions', async t => {
  const runs = [];
  const h = viewFixture(t, { runCheck: request => runs.push(request) });
  const longCommand = `node check.mjs --value=${'x'.repeat(800)}`;
  h.projects.set('board-a', project('a', [{ ...typed, command: longCommand }]));
  await h.view.openProject(h.projects.get('board-a'));
  h.find('.egdesk-file-script-settings-button').click();
  const panel = h.find('.egdesk-file-script-settings'), fields = h.find('.egdesk-file-script-fields');
  const actions = h.find('.egdesk-file-script-actions');
  assert.match(panel.getAttribute('style'), /min-height: 0/);
  assert.match(fields.getAttribute('style'), /overflow: auto/);
  assert.match(fields.getAttribute('style'), /max-height: 20rem/);
  assert.match(actions.getAttribute('style'), /flex: 0 0 auto/);
  assert.equal(actions.parentElement, panel);
  assert.equal(fields.contains(h.find('.egdesk-file-script-save')), false);
  const command = h.find('.egdesk-file-script-command');
  assert.equal(command.parentElement.className, 'egdesk-file-script-command-label');
  assert.match(command.parentElement.getAttribute('style'), /grid-column: 1 \/ -1; grid-row: 2/);
  assert.match(command.getAttribute('style'), /width: 100%/);
  assert.match(command.getAttribute('style'), /ui-monospace/);
  assert.equal(command.type, 'text'); assert.equal(command.maxLength, 1000);
  assert.equal(command.value, longCommand, 'the complete exact single-line command remains editable');
  for (let index = 0; index < 11; index++) h.find('.egdesk-file-script-add').click();
  assert.equal(fields.children.length, 12); assert.equal(h.find('.egdesk-file-script-add').disabled, true);
  for (let index = 1; index < fields.children.length; index++) {
    fields.children[index].querySelector('.egdesk-file-script-name').value = `검사 ${index}`;
    fields.children[index].querySelector('.egdesk-file-script-command').value = `echo ${index}`;
  }
  h.find('.egdesk-file-script-save').click(); await settle();
  assert.equal(h.projects.get('board-a').scripts.length, 12);
  assert.equal(h.projects.get('board-a').scripts[0].command, longCommand);
  assert.equal(runs.length, 0, 'reachable save still stores only and never executes');
  assert.equal(panel.hidden, true);
});

test('typed-command editor saves only user entries, then check displays actual exit and log', async t => {
  const runs = [];
  const h = viewFixture(t, { runCheck: async request => { runs.push(request); return { command: request.script.command, exitCode: 7, status: 'failed', output: 'actual check log\n', durationMs: 10 }; } });
  h.projects.set('board-a', project()); await h.view.openProject(project());
  h.find('.egdesk-file-script-settings-button').click();
  h.find('.egdesk-file-script-name').value = '내 검사'; h.find('.egdesk-file-script-command').value = 'node exact-check.mjs --flag';
  h.find('.egdesk-file-script-save').click(); await settle();
  assert.equal(runs.length, 0); assert.equal(h.calls.filter(call => call[0] === 'scripts').length, 1);
  assert.equal(h.projects.get('board-a').scripts[0].command, 'node exact-check.mjs --flag');
  assert.match(h.find('.egdesk-file-status').textContent, /실행하려면 검사를/);
  h.find('.egdesk-file-project-check').click(); await settle();
  assert.equal(runs.length, 1); assert.equal(runs[0].projectId, 'project-a');
  assert.match(h.find('.egdesk-run-result-exit').textContent, /7/);
  assert.match(h.find('.egdesk-file-check-result').textContent, /actual check log/);
  assert.equal(h.find('.egdesk-file-check-result').getAttribute('aria-busy'), 'false');
  assert.equal(h.find('.egdesk-file-check-stale').hidden, true);
  assert.equal(h.find('.egdesk-file-check-button').hidden, true, 'a project has only one check action');
  assert.match(h.find('.egdesk-file-project-check').title, /디스크에 저장된 원본/);
});

test('shared RunResult styles separate metadata and bound command/output scrolling without File-only duplicates', async t => {
  const css = await fs.readFile(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .map(([, selectors, body]) => ({ selectors: selectors.split(',').map(selector => selector.trim()), body }))
    .filter(rule => rule.selectors.some(selector => selector.includes('.egdesk-run-result')));
  assert.ok(rules.length > 0);
  for (const rule of rules) for (const selector of rule.selectors) {
    assert.ok(selector.startsWith('.egdesk-run-result'), `shared styling must not depend on a File/Chat parent: ${selector}`);
  }
  const style = selector => rules.filter(rule => rule.selectors.includes(selector)).map(rule => rule.body).join(' ');
  const command = `printf '${'QA_RESULT_'.repeat(14)}\\n'`;
  const output = `${'long-output-'.repeat(90)}\n`;
  const receipt = { command, status: 'completed', exitCode: 0, durationMs: 200, output };
  const expected = RunResult.summarizeRunResult({ ...receipt, cwd: '/verified/a', projectRoot: '/verified/a' });
  let runs = 0;
  const h = viewFixture(t, { runCheck: async () => { runs++; return receipt; } });
  await h.view.openProject(project('a', [{ ...typed, command }]));
  h.find('.egdesk-file-project-check').click(); await settle();
  assert.equal(runs, 1);
  const panel = h.find('.egdesk-file-check-result');
  for (const declarations of [panel.getAttribute('style'), style('.egdesk-run-result'), style('.egdesk-run-result-meta'), style('.egdesk-run-result-output')]) {
    assert.match(declarations, /min-width: 0/);
    assert.match(declarations, /max-width: 100%/);
    assert.doesNotMatch(declarations, /overflow(?:-x)?: (?:auto|scroll|hidden)/,
      'the host neither clips content nor substitutes a whole-panel horizontal scroller');
  }
  assert.match(style('.egdesk-run-result-header'), /display: flex.*flex-wrap: wrap.*gap: 4px 10px/);
  assert.match(style('.egdesk-run-result-meta'), /display: flex.*flex-wrap: wrap.*gap: 6px 12px/);
  for (const selector of ['.egdesk-run-result-kind', '.egdesk-run-result-duration', '.egdesk-run-result-exit']) {
    assert.match(style(selector), /white-space: nowrap/);
  }
  assert.equal(h.find('.egdesk-run-result-headline').textContent, expected.headline);
  assert.equal(h.find('.egdesk-run-result-duration').textContent, '0.2초');
  assert.equal(h.find('.egdesk-run-result-exit').textContent, '종료 코드 0');
  for (const [selector, text] of [['.egdesk-run-result-command', expected.command], ['.egdesk-run-result-tail', expected.tail]]) {
    const node = h.find(selector);
    assert.equal(node.textContent, text, 'layout preserves the shared renderer text, including its redaction and display bounds');
    const declarations = style(`.egdesk-run-result ${selector}`);
    assert.match(declarations, /width: 100%.*min-width: 0.*max-width: 100%/);
    assert.match(declarations, /overflow-x: auto; white-space: pre; overflow-wrap: normal/,
      'shared two-class rule outranks the older host pre rule without a File-specific override');
    assert.equal(node.getAttribute('style'), null);
    assert.equal(node.tabIndex, 0, 'long text can be scrolled with the keyboard');
  }
  assert.match(style('.egdesk-run-result-command'), /flex: 0 1 100%/);
  assert.match(style('.egdesk-run-result .egdesk-run-result-tail'), /max-height: 18rem; overflow-y: auto/);
  assert.match(style('.egdesk-run-result-failure'), /margin: 8px 0/);
  assert.match(style('.egdesk-run-result-failure-name'), /display: block; margin-bottom: 4px/);
  for (const selector of ['.egdesk-run-result', '.egdesk-run-result-header', '.egdesk-run-result-meta', '.egdesk-run-result-output']) {
    assert.equal(h.find(selector).getAttribute('style'), null, 'File does not duplicate or override the shared style contract');
  }
  // A second consumer receives the same classes and hence the same shared CSS.
  const untouched = RunResult.renderRunResultCard({ document: h.document, result: expected });
  assert.equal(untouched.getAttribute('style'), null);
  assert.equal(untouched.querySelector('.egdesk-run-result-command').getAttribute('style'), null);
});

test('project-only runner never exposes or dispatches the legacy working-copy check', async t => {
  const runs = [];
  const h = viewFixture(t, { projectChecksOnly: true, runCheck: request => runs.push(request) });
  await h.view.openRoot({ rootId: 'ordinary', directoryId: 'ordinary-dir' }); await h.view.openFile('old-file');
  assert.equal(h.find('.egdesk-file-check-button').hidden, true);
  await h.view.check(); assert.equal(runs.length, 0);
  await h.view.openProject(project()); await h.view.check(); assert.equal(runs.length, 0);
  assert.match(h.find('.egdesk-file-status').textContent, /명령을 먼저 저장/);
});

test('dirty original blocks execution; edits and folder changes make the fixed run receipt visibly stale', async t => {
  const completion = deferred(), runs = [];
  const h = viewFixture(t, { runCheck: request => { runs.push(request); return completion.promise; } });
  await h.view.openProject(project('a', [typed])); await h.view.openFile('file-dir-a');
  const editor = h.find('.egdesk-file-editor'); editor.value = 'dirty'; editor.fire('input');
  h.find('.egdesk-file-project-check').click(); await settle();
  assert.equal(runs.length, 0); assert.match(h.find('.egdesk-file-status').textContent, /먼저 원본에 저장/);
  editor.value = 'start'; editor.fire('input'); await h.view.flush();
  h.find('.egdesk-file-project-check').click(); await settle();
  assert.equal(runs.length, 1); assert.equal(h.find('.egdesk-file-project-check').disabled, true);
  h.view.onFileChanged({ rootId: 'root-a', relativePath: 'source.txt' });
  await h.view.openProject(project('b', [typed]));
  completion.resolve({ status: 'completed', exitCode: 0, output: 'done\n' }); await settle();
  assert.equal(runs[0].rootId, 'root-a');
  assert.match(h.find('.egdesk-file-check-context').textContent, /\/verified\/a/);
  assert.equal(h.find('.egdesk-file-check-stale').hidden, false);
});

test('ambiguous run failure stays unknown and command settings cannot change the pending target', async t => {
  const saved = deferred();
  const h = viewFixture(t, { runCheck: async () => { throw new Error('reply lost after send'); } });
  h.projects.set('board-a', project('a', [typed])); await h.view.openProject(project('a', [typed]));
  h.find('.egdesk-file-project-check').click(); await settle();
  assert.match(h.find('.egdesk-file-check-result').textContent, /확인|unknown/i);
  h.service.setProjectScripts = async request => { h.calls.push(['delayed-scripts', request]); return saved.promise; };
  h.find('.egdesk-file-script-settings-button').click(); h.find('.egdesk-file-script-name').value = 'A 수정';
  h.find('.egdesk-file-script-save').click(); await settle();
  await h.view.openProject(project('b', [{ ...typed, command: 'B command' }]));
  saved.resolve({ projectId: 'project-a', scripts: [{ ...typed, command: 'A changed' }] }); await settle();
  assert.equal(h.view.snapshot().projectId, 'project-b');
  assert.match(h.find('.egdesk-file-project-check').title, /B command/);
});

async function cardFixture(t, { service = null } = {}) {
  const h = fakeService(), document = fakeDocument(), runs = [], terminalOptions = [], terminalApis = [];
  if (service) h.service = service;
  let runStatus = 'completed';
  let target = { boardId: 'board-a', title: 'A 보드' }, nextPick = null, pickerCalls = 0, sequence = 0;
  const el = (tag, props = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (key === 'class') node.className = value;
      else if (key === 'data') Object.assign(node.dataset, value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else if (key === 'style' || key === 'hidden' || key === 'id') node[key] = value;
      else node.setAttribute(key, value);
    }
    for (const child of children) { if (typeof child === 'string') node.textContent += child; else if (child) node.append(child); }
    return node;
  };
  class Picker {
    init() {}
    open(callback) { pickerCalls++; Promise.resolve(nextPick).then(path => { this.file = path ? { path } : null; callback(path ? 1 : 0); }); }
  }
  const globals = { document, window: { AbortController, setTimeout, clearTimeout },
    ChromeUtils: { importESModule: () => ({ ...FileView, createEGDeskFileServiceCallbacks: () => h.service }) },
    Cc: { '@mozilla.org/filepicker;1': { createInstance: () => new Picker() } }, Ci: { nsIFilePicker: { modeGetFolder: 2, returnOK: 1, returnCancel: 0 } } };
  const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  t.after(async () => {
    for (const card of document.body.querySelectorAll('.egd-file-card')) await card._fileView?.close();
    for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; }
  });
  const zone = createFileCardZone({ FileCardState, allocCardSeq: () => ++sequence, boardNotice() {}, chatBindingNonce: () => String(sequence),
    chatInputSourceForView() {}, cloneJson: structuredClone, el, focusCanvasCard() {}, getCodexThreadById() {}, getProjectTarget: () => target,
    markAgendaDirty() {}, openChatInputPanel() {}, resolveCanvasCardPlacement: () => ({ x: 0, y: 0, width: 600, height: 400 }), revealPlacedCanvasCard() {},
    spawnDeskWindowShell: options => {
      const root = el('article', { class: options.className, id: options.id }), identity = el('header'), actions = el('nav'), content = el('main');
      root.append(identity, actions, content); document.body.append(root); return { root, slots: { identity, actions, content } };
    },
    spawnTerminalCard: options => { terminalOptions.push(options); const card = el('article', { class: 'egd-terminal-card' }); document.body.append(card);
      let inputRevision = 0;
      const api = { ptyId: `terminal-${terminalOptions.length}`, isConnected: () => true, inputRevision: () => inputRevision,
        write: () => { inputRevision++; }, runScript: async request => { runs.push(request); return { status: runStatus, exitCode: runStatus === 'unknown' ? null : 0,
          projectId: request.projectId, rootId: request.rootId, sessionId: api.ptyId, output: 'real receipt fixture\n' }; } };
      terminalApis.push(api); card._termBrowser = { contentWindow: { terminalAPI: api } }; return card; },
    state: { codex: {} },
  });
  return { ...h, document, runs, terminalOptions, terminalApis, runStatus: value => { runStatus = value; }, setTarget: value => { target = value; }, pick: value => { nextPick = value; }, pickerCalls: () => pickerCalls,
    spawn: async options => { const card = zone.spawnFileCard(options); await card._fileReady; assert.ok(card._fileView, card.textContent); return card; } };
}

test('File Card header gives long titles only the remaining width and keeps its status label and controls intact', async t => {
  const css = await fs.readFile(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
  const titleStyle = /\.egd-file-card-title\s*\{([^}]+)\}/.exec(css)?.[1] || '';
  const stateStyle = /\.egd-file-card-state\s*\{([^}]+)\}/.exec(css)?.[1] || '';
  assert.match(titleStyle, /flex: 1 1 0%; min-width: 0/);
  assert.match(titleStyle, /overflow: hidden; text-overflow: ellipsis; white-space: nowrap/);
  assert.match(stateStyle, /flex: 0 0 auto; white-space: nowrap/);
  const h = await cardFixture(t), longTitle = 'Owned QA Project Board — 긴 프로젝트 이름과 전체 경로 '.repeat(20);
  h.setTarget({ boardId: 'board-a', title: longTitle });
  h.projects.set('board-a', { ...project(), title: longTitle });
  const card = await h.spawn();
  card.querySelector('.egdesk-file-project-connect').click(); await settle();
  const title = card.querySelector('.egd-file-card-title'), badge = card.querySelector('.egd-file-card-state');
  assert.equal(title.textContent, longTitle); assert.equal(title.title, longTitle, 'full Board name remains available without visual clipping of other header items');
  assert.equal(badge.textContent, '파일'); assert.equal(badge.getAttribute('role'), 'status'); assert.equal(badge.hidden, false);
  assert.equal(card.querySelector('.egd-file-chat-attach').textContent, 'Chat에 첨부');
  assert.equal(card.querySelector('.egd-file-chat-attach').hidden, false);
  assert.equal(h.pickerCalls(), 0); assert.equal(h.runs.length, 0);
});

test('File Card cancellation preserves dirty data and successful association cannot overwrite that Card', async t => {
  const h = await cardFixture(t), card = await h.spawn();
  await card._fileView.openRoot({ rootId: 'ordinary', directoryId: 'ordinary-dir' }); await card._fileView.openFile('old-file');
  const editor = card.querySelector('.egdesk-file-editor'); editor.value = 'keep this dirty text'; editor.fire('input');
  const before = card._fileView.snapshot();
  card.querySelector('.egdesk-file-project-connect').click(); await settle();
  assert.equal(h.pickerCalls(), 1); assert.equal(editor.value, 'keep this dirty text');
  assert.equal(card._fileView.snapshot().fileId, before.fileId); assert.equal(h.calls.some(call => call[0] === 'attach'), false);
  h.pick('/picked/a'); card.querySelector('.egdesk-file-project-connect').click(); await settle(5);
  const cards = h.document.body.querySelectorAll('.egd-file-card'); assert.equal(cards.length, 2);
  assert.equal(card._fileView.snapshot().projectId, null); assert.equal(editor.value, 'keep this dirty text');
  assert.equal(cards[1]._fileView.snapshot().projectId, 'project-a');
});

test('File Card existing association avoids picker, holds its Board for check, and spawns a background Terminal', async t => {
  const h = await cardFixture(t); h.projects.set('board-a', project('a', [typed]));
  const card = await h.spawn(); card.querySelector('.egdesk-file-project-connect').click(); await settle();
  assert.equal(h.pickerCalls(), 0); assert.equal(card._fileView.snapshot().projectId, 'project-a');
  h.setTarget({ boardId: 'board-b', title: 'B 보드' });
  card.querySelector('.egdesk-file-project-check').click(); await settle(5);
  assert.equal(h.runs.length, 1); assert.equal(h.runs[0].boardId, 'board-a');
  assert.deepEqual(h.terminalOptions, [{ activate: false, reveal: false, projectId: 'project-a', rootId: 'root-a' }]);
  assert.equal(Object.hasOwn(h.runs[0], 'cwd'), false);
  assert.ok(h.calls.filter(call => call[0] === 'open').every(call => call[1] === 'board-a'));
  card.querySelector('.egdesk-file-project-check').click(); await settle(5);
  assert.equal(h.runs.length, 2); assert.equal(h.terminalOptions.length, 1, 'confirmed owned idle runner is reused on another explicit check');
  h.terminalApis[0].write('human intervention');
  card.querySelector('.egdesk-file-project-check').click(); await settle(5);
  assert.equal(h.terminalOptions.length, 2, 'human intervention disqualifies the old runner');
  h.runStatus('unknown'); card.querySelector('.egdesk-file-project-check').click(); await settle(5);
  assert.equal(h.terminalOptions.length, 2);
  card.querySelector('.egdesk-file-project-check').click(); await settle(5);
  assert.equal(h.terminalOptions.length, 3, 'an uncertain run is never silently reused');
});

test('File Card reopens its stored Board association with dirty content and refuses changed project/root bindings', async t => {
  const h = await cardFixture(t); h.projects.set('board-a', project('a', [typed]));
  const card = await h.spawn(); card.querySelector('.egdesk-file-project-connect').click(); await settle();
  await card._fileView.openFile('file-dir-a');
  card.querySelector('.egdesk-file-editor').value = 'keep on reopen'; card.querySelector('.egdesk-file-editor').fire('input');
  await card._fileView.flush();
  const record = structuredClone(card._fileRecord);
  assert.deepEqual(record.project, { projectId: 'project-a', boardId: 'board-a' });
  assert.doesNotMatch(JSON.stringify(record), /verified|npm test/);
  assert.equal(await card._beforeClose(), true); card.remove();
  h.setTarget({ boardId: 'board-b', title: 'B 보드' }); h.calls.length = 0;
  const restored = await h.spawn({ restore: true, record });
  assert.equal(restored._fileView.snapshot().projectId, 'project-a');
  assert.equal(restored.querySelector('.egdesk-file-editor').value, 'keep on reopen');
  assert.deepEqual(h.calls.filter(call => call[0] === 'open'), [['open', 'board-a']]);
  for (const replacement of [project('different', [typed]), { ...project('a', [typed]), rootId: 'different-root' }]) {
    h.projects.set('board-a', replacement);
    const mismatched = await h.spawn({ restore: true, record });
    assert.equal(mismatched._fileView.snapshot().projectId, null);
    assert.equal(mismatched.querySelector('.egdesk-file-editor').value, 'keep on reopen');
    assert.match(mismatched.querySelector('.egd-file-card-notice').textContent, /연결 확인 필요|새 파일 카드/);
    assert.equal(mismatched.querySelector('.egdesk-file-project-check').hidden, true);
  }
  h.projects.set('board-a', project('a', [typed]));
  h.drafts.get(record.draftId).rootId = 'foreign-root';
  const foreignDraft = await h.spawn({ restore: true, record });
  assert.equal(foreignDraft._fileView.snapshot().projectId, null, 'a valid Board/root cannot relabel another root\'s managed draft');
  assert.equal(foreignDraft.querySelector('.egdesk-file-editor').value, 'keep on reopen');
});

test('real helper restart opens the verified project with fresh handles while retaining the old dirty draft separately', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-project-card-restart-'));
  const rootPath = path.join(temp, 'project'), draftDirectory = path.join(temp, 'drafts');
  await fs.mkdir(rootPath); await fs.writeFile(path.join(rootPath, 'source.txt'), 'disk original\n');
  const makeAdapter = () => createEGDeskFileHttpAdapter({ draftDirectory, localOwnerScope: 'egdesk-local',
    gitReview: { status: async () => ({ available: false, isRepo: false, entries: [] }) } });
  let adapter = makeAdapter();
  const requests = [];
  const service = FileView.createEGDeskFileServiceCallbacks({ request: async (pathname, body, options = {}) => {
    requests.push({ pathname, body });
    const headers = { host: '127.0.0.1:39218', 'content-type': 'application/json', ...Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value])) };
    return (await adapter.dispatch({ method: 'POST', pathname, body,
      request: { method: 'POST', url: pathname, headers, socket: { remoteAddress: '127.0.0.1' } } })).body;
  } });
  const h = await cardFixture(t, { service });
  t.after(async () => { await adapter.close(); await fs.rm(temp, { recursive: true, force: true }); });
  h.pick(rootPath);
  const first = await h.spawn(); first.querySelector('.egdesk-file-project-connect').click(); await until(() => !first.querySelector('.egdesk-file-project-connect').disabled);
  assert.ok(first._fileView.snapshot().projectId, first.textContent);
  first.querySelector('[role="treeitem"]').click(); await until(() => !!first._fileView.snapshot().draftId);
  first.querySelector('.egdesk-file-editor').value = 'preserve dirty after helper restart'; first.querySelector('.egdesk-file-editor').fire('input');
  await first._fileView.flush();
  const record = structuredClone(first._fileRecord), previousRoot = record.root.rootId;
  assert.equal(await first._beforeClose(), true); first.remove();
  await adapter.close(); adapter = makeAdapter();
  h.setTarget({ boardId: 'board-b', title: 'B 보드' }); requests.length = 0;
  const oldDraftCard = await h.spawn({ restore: true, record });
  const reopened = h.document.body.querySelectorAll('.egd-file-card').find(card => card._fileView?.snapshot().projectId === record.project.projectId);
  assert.ok(reopened, oldDraftCard.textContent);
  assert.notEqual(reopened._fileView.snapshot().rootId, previousRoot);
  assert.equal(oldDraftCard._fileView.snapshot().projectId, null);
  assert.equal(oldDraftCard.querySelector('.egdesk-file-editor').value, 'preserve dirty after helper restart');
  assert.match(oldDraftCard.querySelector('.egd-file-card-notice').textContent, /새 파일 카드/);
  assert.equal(Object.hasOwn(oldDraftCard._fileRecord, 'project'), false, 'old draft does not spawn another project Card on every restart');
  assert.equal(h.pickerCalls(), 1, 'verified same-folder reopening needs no second picker');
  assert.ok(requests.filter(request => request.pathname.endsWith('/projects/open')).every(request => request.body.boardId === 'board-a'));
  assert.equal(await fs.readFile(path.join(rootPath, 'source.txt'), 'utf8'), 'disk original\n');
  assert.equal(h.runs.length, 0);
  const newRecord = structuredClone(reopened._fileRecord);
  await adapter.close(); await fs.rename(rootPath, `${rootPath}-old`); await fs.mkdir(rootPath); adapter = makeAdapter();
  const replacedFolder = await h.spawn({ restore: true, record: newRecord });
  assert.equal(replacedFolder._fileView.snapshot().projectId, null, 'same display path with another inode is not silently adopted');
  assert.match(replacedFolder.querySelector('.egd-file-card-notice').textContent, /연결 확인 필요/);
});

test('File Card records remain backwards compatible and only persist opaque Board/project references', () => {
  const old = FileCardState.fileCardRecord({ rootId: 'root', directoryId: 'dir', displayPath: '/private' }, {});
  assert.equal(Object.hasOwn(old, 'project'), false);
  const next = FileCardState.fileCardRecord(old.root, {}, { boardId: 'board', projectId: 'project', cwd: '/private', scripts: [typed] });
  assert.deepEqual(next.project, { projectId: 'project', boardId: 'board' });
  assert.doesNotMatch(JSON.stringify(next), /private|npm test/);
  assert.equal(Object.hasOwn(FileCardState.fileCardRecord(null, {}, { boardId: 'bad\0', projectId: 'project' }), 'project'), false);
});
