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
    if (tag === 'details') this.open = false;
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
  click() {
    if (this.disabled) return;
    this.fire('click');
    if (this.tagName === 'summary' && this.parentElement?.tagName === 'details') this.parentElement.open = !this.parentElement.open;
  }
}
function fakeDocument() {
  const document = { createElement: tag => new Element(document, tag), activeElement: null };
  document.body = document.createElement('body');
  document.querySelector = selector => document.body.querySelector(selector);
  document.querySelectorAll = selector => document.body.querySelectorAll(selector);
  return document;
}
const settle = async (turns = 3) => { for (let index = 0; index < turns; index++) await new Promise(resolve => setImmediate(resolve)); };
const until = async predicate => { const end = Date.now() + 3000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 2)); assert.ok(predicate(), 'bounded UI operation completed'); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const project = (suffix = 'a', scripts = []) => ({ projectId: `project-${suffix}`, rootId: `root-${suffix}`, directoryId: `dir-${suffix}`,
  title: `보드 ${suffix}`, name: suffix, source: 'board', status: 'connected', displayPath: `/verified/${suffix}`,
  scripts: structuredClone(scripts), saveAsAvailable: true, capability: 'read-and-create-only' });
const typed = { id: 'test', name: '직접 검사', command: 'npm test', kind: 'test' };

function fakeService() {
  const projects = new Map(), drafts = new Map(), calls = [], writes = [];
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
    updateDraft: async ({ draftId, text }) => { writes.push('updateDraft'); const draft = { ...drafts.get(draftId), text, head: `h${++revision}`, bufferRevision: revision }; drafts.set(draftId, draft); return { ...draft }; },
    saveDraft: async ({ draftId }) => { writes.push('saveDraft'); const draft = drafts.get(draftId); draft.savedRevision = draft.bufferRevision; return { draft: { ...draft }, receipt: { savedRevision: draft.savedRevision } }; },
    saveAs: async () => { writes.push('saveAs'); return {}; }, diffDraft: async () => ({ hunks: [] }),
    openProject: async ({ boardId }) => { calls.push(['open', boardId]); return { project: structuredClone(projects.get(boardId) || null), source: projects.has(boardId) ? 'board' : null }; },
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
  return { service, projects, calls, drafts, writes };
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
  assert.match(style('.egdesk-run-result-command'), /line-height: 1\.5; padding-bottom: 16px; min-height: calc\(1\.5em \+ 16px\)/,
    'the native overlay scrollbar has space below the glyph line without changing copyable command text');
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

test('check outcome precedes compact execution details; opening them reveals the unchanged original project and full path', async t => {
  const completion = deferred(), runs = [];
  const h = viewFixture(t, { runCheck: request => { runs.push(request); return completion.promise; } });
  const original = { ...project('a', [typed]), title: '실행한 프로젝트 '.repeat(15), displayPath: `/private/${'long-folder/'.repeat(12)}original-workspace` };
  await h.view.openProject(original);
  h.find('.egdesk-file-project-check').click(); await settle();
  await h.view.openProject({ ...project('b', [typed]), title: '나중에 선택한 프로젝트', displayPath: '/later/workspace' });
  completion.resolve({ status: 'completed', exitCode: 0, output: 'original run\n' }); await settle();
  const card = h.find('.egdesk-run-result'), details = h.find('[data-testid="file-check-location-details"]');
  const toggle = h.find('[data-testid="file-check-location-toggle"]'), path = h.find('[data-testid="file-check-cwd"]');
  assert.equal(details.tagName, 'details'); assert.equal(details.open, false); assert.equal(toggle.tagName, 'summary');
  assert.deepEqual(card.children.slice(0, 3).map(node => node.className), ['egdesk-run-result-header', 'egdesk-file-check-context', 'egdesk-run-result-meta']);
  assert.equal(h.find('.egdesk-run-result-headline').textContent, '테스트 통과');
  assert.equal(toggle.textContent, `실행 위치 · ${original.title}`);
  assert.equal(toggle.textContent.includes(original.displayPath), false, 'collapsed location does not show the multi-line raw path');
  assert.match(h.find('.egdesk-file-check-context-label').getAttribute('style'), /text-overflow: ellipsis; white-space: nowrap/);
  toggle.click();
  assert.equal(details.open, true); assert.equal(path.parentElement, details);
  assert.equal(path.textContent, `실행 폴더 · ${original.displayPath}`);
  assert.equal(h.find('.egdesk-file-check-project-name').textContent, `프로젝트 · ${original.title}`);
  assert.equal(details.textContent.includes('/later/workspace'), false);
  assert.equal(h.find('.egdesk-file-check-stale').hidden, false);
  assert.equal(runs.length, 1); assert.equal(runs[0].projectId, 'project-a'); assert.equal(runs[0].rootId, 'root-a');
  toggle.click(); assert.equal(details.open, false); assert.equal(runs.length, 1, 'details never reruns or retargets a check');
});

test('file selection empty state follows rendered results and restores after result clear and root reset without extra actions', async t => {
  const completion = deferred(), runs = [], serviceCalls = [];
  const h = viewFixture(t, { runCheck: request => { runs.push(request); return completion.promise; } });
  for (const [name, callback] of Object.entries(h.service)) {
    h.service[name] = async (...args) => { serviceCalls.push(name); return callback(...args); };
  }
  const viewer = h.find('.egdesk-file-viewer'), panel = h.find('.egdesk-file-check-result');
  assert.equal(viewer.hidden, true, 'an unconnected view keeps its initial state');
  await h.view.openProject(project('a', [typed]));
  assert.equal(panel.hidden, true); assert.equal(viewer.hidden, false);
  assert.equal(viewer.textContent, '트리에서 파일을 선택하세요.');
  const treeItem = h.find('[role="treeitem"]'); treeItem.focus();
  const buttons = h.view.element.querySelectorAll('button');
  h.find('.egdesk-file-project-check').click(); await settle();
  assert.equal(panel.hidden, false); assert.equal(panel.getAttribute('aria-busy'), 'true');
  assert.equal(viewer.hidden, false, 'a pending run is not a rendered result');
  completion.resolve({ status: 'completed', exitCode: 0, output: 'passed\n' }); await settle();
  assert.equal(panel.hidden, false); assert.equal(viewer.hidden, true, 'a visible outcome replaces only the no-file prompt');
  assert.equal(viewer.textContent, '트리에서 파일을 선택하세요.', 'the prompt is retained for restoration');
  assert.equal(h.find('.egdesk-file-tree').hidden, false); assert.equal(h.find('[role="treeitem"]'), treeItem);
  assert.equal(h.document.activeElement, treeItem, 'result presentation does not move focus');
  assert.deepEqual(h.view.element.querySelectorAll('button'), buttons, 'result presentation adds no action');
  assert.deepEqual(serviceCalls, ['listDirectory'], 'rendering does not read, save, pick, or connect anything');
  h.find('[data-testid="file-check-location-toggle"]').click();
  assert.deepEqual(serviceCalls, ['listDirectory']); assert.equal(runs.length, 1);
  await h.view.openRoot({ rootId: 'ordinary', directoryId: 'ordinary-dir', name: '일반 폴더' });
  assert.equal(viewer.hidden, true, 'a retained stale result still replaces the no-file prompt after a root change');
  assert.equal(h.find('.egdesk-file-check-stale').hidden, false);
  await h.view.openFile('file-ordinary-dir');
  assert.equal(panel.hidden, true, 'opening a file clears the displayed result');
  assert.equal(h.find('.egdesk-file-editor-label').hidden, false);
  assert.equal(h.find('.egdesk-file-editor').value, 'start');
  await h.view.openRoot({ rootId: 'ordinary', directoryId: 'ordinary-dir', name: '일반 폴더' });
  assert.equal(panel.hidden, true); assert.equal(viewer.hidden, false, 'resetting the no-file view restores its prompt');
  assert.equal(viewer.textContent, '트리에서 파일을 선택하세요.');
  assert.equal(h.view.snapshot().fileId, null); assert.equal(h.find('.egdesk-file-editor-label').hidden, true);
  assert.equal(h.find('.egdesk-file-tree').hidden, false); assert.equal(runs.length, 1);
  assert.deepEqual(serviceCalls, ['listDirectory', 'listDirectory', 'readFile', 'createDraft', 'listDirectory'],
    'only the explicit root/file actions reach the service');
});

test('replacing a result with command choice or a pending run restores the prompt until an actual result is rendered', async t => {
  const completions = [deferred(), deferred()], runs = [], renderer = deferred();
  const h = viewFixture(t, { parts: { runResult: renderer.promise },
    runCheck: request => { runs.push(request); return completions[runs.length - 1].promise; } });
  await h.view.openProject(project('a', [typed]));
  h.find('.egdesk-file-project-check').click(); await settle();
  completions[0].resolve({ status: 'completed', exitCode: 0, output: 'first\n' }); await settle();
  assert.equal(h.find('.egdesk-file-check-result').getAttribute('aria-busy'), 'false');
  assert.equal(h.find('.egdesk-file-viewer').hidden, false, 'a receipt without rendered result content is not enough');
  renderer.resolve(RunResult); await settle();
  assert.equal(h.find('.egdesk-file-viewer').hidden, true);
  h.view.setProjectScripts([typed, { ...typed, id: 'other', name: '다른 검사', command: 'echo other' }]);
  assert.equal(h.find('.egdesk-file-viewer').hidden, true, 'marking an existing result stale does not clear it');
  h.find('.egdesk-file-project-check').click(); await settle();
  assert.ok(h.find('.egdesk-file-check-scripts')); assert.equal(h.find('.egdesk-run-result'), null);
  assert.equal(h.find('.egdesk-file-viewer').hidden, false); assert.equal(runs.length, 1);
  h.find('.egdesk-file-check-script').click(); await settle();
  assert.equal(h.find('.egdesk-file-check-result').getAttribute('aria-busy'), 'true');
  assert.equal(h.find('.egdesk-file-viewer').hidden, false); assert.equal(runs.length, 2);
  completions[1].resolve({ status: 'failed', exitCode: 7, output: 'second failed\n' }); await settle();
  assert.equal(h.find('.egdesk-file-viewer').hidden, true);
  assert.match(h.find('.egdesk-run-result-exit').textContent, /7/);
  assert.match(h.find('.egdesk-file-check-result').textContent, /second failed/);
  assert.equal(runs.length, 2, 'only the two explicit check selections run');
});

test('plain and unavailable-renderer check results also replace only the no-file prompt', async t => {
  for (const scenario of [
    { parts: { runResult: RunResult }, result: { summary: 'plain result' } },
    { parts: { runResult: null }, result: { summary: 'renderer unavailable', exitCode: 0, output: 'completed\n' } },
  ]) {
    let runs = 0;
    const h = viewFixture(t, { parts: scenario.parts, runCheck: async () => { runs++; return scenario.result; } });
    await h.view.openProject(project('a', [typed]));
    assert.equal(h.find('.egdesk-file-viewer').hidden, false);
    await h.view.check();
    assert.equal(h.find('.egdesk-file-check-result').hidden, false);
    assert.equal(h.find('.egdesk-file-viewer').hidden, true);
    assert.equal(h.find('.egdesk-file-check-body').textContent, scenario.result.summary);
    assert.equal(h.find('[data-testid="file-check-location-details"]').open, false);
    assert.equal(h.find('.egdesk-file-tree').hidden, false); assert.equal(runs, 1);
  }
});

for (const selection of ['none', 'text', 'binary']) {
  test('check results preserve real errors, the tree, and ' + selection + ' file state', async t => {
    const completion = deferred(), runs = [];
    const h = viewFixture(t, { runCheck: request => { runs.push(request); return completion.promise; } });
    const readFile = h.service.readFile;
    let rejectRead = false;
    h.service.readFile = async request => {
      if (rejectRead) throw Object.assign(new Error('missing source'), { code: 'RESOURCE_UNAVAILABLE' });
      return { ...await readFile(request), kind: selection === 'binary' ? 'binary' : 'text' };
    };
    await h.view.openProject(project('a', [typed]));
    if (selection !== 'none') await h.view.openFile('file-dir-a');
    const before = h.view.snapshot(), editor = h.find('.egdesk-file-editor');
    const viewer = h.find('.egdesk-file-viewer'), text = viewer.textContent;
    h.find('.egdesk-file-project-check').click(); await settle();
    rejectRead = true;
    h.find('[role="treeitem"]').click(); await settle();
    const error = h.find('.egdesk-file-error'), errorText = error.textContent;
    assert.equal(error.hidden, false); assert.match(errorText, /파일을 찾을 수 없거나/);
    completion.resolve({ status: 'completed', exitCode: 0, output: 'finished\n' }); await settle();
    assert.equal(h.find('.egdesk-file-check-result').hidden, false);
    assert.equal(error.hidden, false); assert.equal(error.textContent, errorText, 'a result must not suppress an independent real error');
    assert.equal(h.find('.egdesk-file-tree').hidden, false);
    assert.equal(h.find('.egdesk-file-editor-label').hidden, selection !== 'text');
    assert.equal(viewer.hidden, selection !== 'binary');
    assert.equal(viewer.textContent, text, 'read-only information and retained empty text are never overwritten');
    if (selection === 'text') assert.equal(editor.value, 'start');
    if (selection === 'binary') assert.equal(viewer.textContent, '이 형식은 편집할 수 없습니다.');
    assert.equal(h.view.snapshot().fileId, before.fileId); assert.equal(h.view.snapshot().draftId, before.draftId);
    assert.equal(runs.length, 1);
  });
}

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
  const notices = [], focused = [], presentations = [];
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
  const zone = createFileCardZone({ FileCardState, allocCardSeq: () => ++sequence, boardNotice: message => notices.push(message), chatBindingNonce: () => String(sequence),
    chatInputSourceForView() {}, cloneJson: structuredClone, el, focusCanvasCard: card => focused.push(card), getCodexThreadById() {}, getProjectTarget: () => target,
    markAgendaDirty() {}, openChatInputPanel() {}, resolveCanvasCardPlacement: () => ({ x: 0, y: 0, width: 600, height: 400 }),
    revealPlacedCanvasCard: card => presentations.push({ type: 'reveal', cardId: card.id }),
    spawnDeskWindowShell: options => {
      const root = el('article', { class: options.className, id: options.id }), identity = el('header'), actions = el('nav'), content = el('main');
      presentations.push({ type: 'spawn', cardId: options.id, activate: options.activate });
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
  return { ...h, document, runs, terminalOptions, terminalApis, notices, focused, presentations, openIde: () => zone.openBoardProjectFile(),
    runStatus: value => { runStatus = value; }, setTarget: value => { target = value; }, pick: value => { nextPick = value; }, pickerCalls: () => pickerCalls,
    spawn: async options => { const card = zone.spawnFileCard(options); await card._fileReady; assert.ok(card._fileView, card.textContent); return card; } };
}

test('IDE entry verifies the selected Board project and opens a File without commands, Terminal or provider work', async t => {
  const h = await cardFixture(t); h.projects.set('board-a', project('a', [typed]));
  const result = await h.openIde();
  assert.equal(result.status, 'opened'); assert.equal(result.reused, false);
  const card = h.document.body.querySelector('.egd-file-card');
  assert.equal(result.cardId, card.id);
  assert.deepEqual(card._fileRecord.project, { boardId: 'board-a', projectId: 'project-a' });
  assert.equal(card._fileView.snapshot().rootId, 'root-a');
  assert.equal(card.getAttribute('aria-label'), '파일 작업 창');
  assert.deepEqual(h.calls.filter(call => call[0] === 'open'), [['open', 'board-a'], ['open', 'board-a']],
    'the same Board is verified before and after the new view is ready');
  assert.equal(h.pickerCalls(), 0); assert.deepEqual(h.runs, []); assert.deepEqual(h.terminalOptions, []);
  assert.deepEqual(h.presentations, [{ type: 'spawn', cardId: card.id, activate: false }], 'the guarded IDE caller owns activation and camera reveal');
  assert.equal(card.querySelector('.egdesk-file-check-result').hidden, true, 'no result is not a successful check');
});

test('IDE reclick reuses only the exact Board/project/root card and never flushes its dirty draft or the other project', async t => {
  const h = await cardFixture(t); h.projects.set('board-a', project());
  const other = await h.spawn({ openMode: 'new', project: project('b'), projectTarget: { boardId: 'board-b', title: 'B' } });
  await other._fileView.openFile('file-dir-b');
  other.querySelector('.egdesk-file-editor').value = 'OTHER DIRTY'; other.querySelector('.egdesk-file-editor').fire('input');
  await other._fileView.flush();
  const opened = await h.openIde(), card = h.document.body.querySelectorAll('.egd-file-card').find(value => value.id === opened.cardId);
  await card._fileView.openFile('file-dir-a');
  const editor = card.querySelector('.egdesk-file-editor'); editor.value = 'SELECTED DIRTY'; editor.fire('input');
  await card._fileView.flush(); editor.selectionStart = 3; editor.selectionEnd = 7; editor.focus();
  const before = [structuredClone(card._fileRecord), card._fileView.snapshot(), structuredClone(other._fileRecord), other._fileView.snapshot(), structuredClone([...h.drafts])];
  const writesBeforeReuse = h.writes.length;
  for (let index = 0; index < 2; index++) {
    const result = await h.openIde();
    assert.equal(result.status, 'opened'); assert.equal(result.reused, true); assert.equal(result.cardId, card.id);
  }
  assert.equal(h.document.body.querySelectorAll('.egd-file-card').length, 2);
  assert.deepEqual([card._fileRecord, card._fileView.snapshot(), other._fileRecord, other._fileView.snapshot(), [...h.drafts]], before);
  assert.deepEqual([editor.value, editor.selectionStart, editor.selectionEnd], ['SELECTED DIRTY', 3, 7]);
  assert.equal(other.querySelector('.egdesk-file-editor').value, 'OTHER DIRTY');
  assert.equal(h.writes.length, writesBeforeReuse, 'reusing the existing view performs no draft or original save');
  assert.deepEqual(h.focused, [], 'the guarded IDE caller owns focus after a verified reuse');
  assert.deepEqual(h.runs, []); assert.deepEqual(h.terminalOptions, []);
});

test('IDE missing-project picker cancellation changes no Board, card or draft; an explicit choice uses the existing verified attachment', async t => {
  const h = await cardFixture(t), other = await h.spawn({ openMode: 'new', project: project('b'), projectTarget: { boardId: 'board-b', title: 'B' } });
  await other._fileView.openFile('file-dir-b');
  other.querySelector('.egdesk-file-editor').value = 'KEEP OTHER'; other.querySelector('.egdesk-file-editor').fire('input'); await other._fileView.flush();
  const before = [structuredClone(other._fileRecord), other._fileView.snapshot(), structuredClone([...h.drafts]), structuredClone([...h.projects])];
  const cancelled = await h.openIde();
  assert.equal(cancelled.status, 'cancelled'); assert.equal(h.pickerCalls(), 1);
  assert.equal(h.document.body.querySelectorAll('.egd-file-card').length, 1);
  assert.deepEqual([other._fileRecord, other._fileView.snapshot(), [...h.drafts], [...h.projects]], before);
  assert.equal(h.calls.some(call => ['attach', 'root'].includes(call[0])), false);
  h.pick('/explicitly/picked/a');
  const opened = await h.openIde();
  assert.equal(opened.status, 'opened'); assert.equal(opened.reused, false);
  assert.equal(h.document.body.querySelectorAll('.egd-file-card').length, 2);
  assert.deepEqual(h.calls.filter(call => call[0] === 'attach'), [['attach', 'board-a', 'A 보드']]);
  assert.deepEqual(other._fileRecord, before[0]); assert.deepEqual(other._fileView.snapshot(), before[1]);
  assert.equal(other.querySelector('.egdesk-file-editor').value, 'KEEP OTHER');
  assert.deepEqual(h.runs, []); assert.deepEqual(h.terminalOptions, []);
});

test('IDE reconnect-required uses the existing picker and does not change the Board on cancellation', async t => {
  const h = await cardFixture(t);
  h.projects.set('board-a', { projectId: 'project-a', title: 'A', name: 'a', source: 'board',
    status: 'reconnect-required', reason: 'identity-changed', scripts: [] });
  const before = structuredClone([...h.projects]);
  assert.equal((await h.openIde()).status, 'cancelled');
  assert.deepEqual([...h.projects], before); assert.equal(h.document.body.children.length, 0);
  assert.equal(h.calls.some(call => call[0] === 'attach'), false);
  h.pick('/selected/a');
  assert.equal((await h.openIde()).status, 'opened');
  assert.equal(h.document.body.querySelector('.egd-file-card')._fileView.snapshot().projectId, 'project-a');
  assert.deepEqual(h.runs, []); assert.deepEqual(h.terminalOptions, []);
});

test('IDE does not create a card when attachment cannot be read back as the same Board project', async t => {
  const h = await cardFixture(t); let reads = 0;
  h.service.openProject = async () => ++reads === 1 ? { project: null, source: null } : { project: project('b'), source: 'board' };
  h.pick('/selected/a');
  assert.equal((await h.openIde()).status, 'unavailable');
  assert.equal(h.calls.filter(call => call[0] === 'attach').length, 1, 'the explicit selection may already have attached');
  assert.equal(h.document.body.children.length, 0);
  assert.deepEqual(h.runs, []); assert.deepEqual(h.terminalOptions, []);
});

test('IDE with no selected Board only gives the existing notice and creates or connects nothing', async t => {
  const h = await cardFixture(t); h.setTarget(null);
  assert.deepEqual(await h.openIde(), { status: 'no-board' });
  assert.deepEqual(h.notices, ['프로젝트를 연결할 보드를 먼저 선택하세요.']);
  assert.deepEqual(h.calls, []); assert.equal(h.pickerCalls(), 0); assert.equal(h.document.body.children.length, 0);
  assert.deepEqual(h.runs, []); assert.deepEqual(h.terminalOptions, []);
});

test('IDE missing or failed verification never falls back to the first File or launches a picker', async t => {
  const h = await cardFixture(t), other = await h.spawn({ openMode: 'new', project: project('b'), projectTarget: { boardId: 'board-b', title: 'B' } });
  const original = structuredClone(other._fileRecord);
  for (const response of [undefined, {}, { project: undefined }, { project: { ...project(), source: 'room' }, source: 'room' },
    { project: { ...project(), rootId: '' }, source: 'board' }, { project: { ...project(), status: 'unknown' }, source: 'board' }]) {
    h.service.openProject = async () => response;
    assert.equal((await h.openIde()).status, 'unavailable');
  }
  h.service.openProject = async () => { throw new Error('offline'); };
  assert.equal((await h.openIde()).status, 'unavailable');
  assert.equal(h.document.body.querySelectorAll('.egd-file-card').length, 1); assert.deepEqual(other._fileRecord, original);
  assert.deepEqual(h.focused, []); assert.equal(h.pickerCalls(), 0); assert.deepEqual(h.runs, []); assert.deepEqual(h.terminalOptions, []);
});

test('IDE coalesces same Board clicks but honors a newer different Board while the first lookup is pending', async t => {
  const h = await cardFixture(t), pending = deferred(); let reads = 0;
  h.service.openProject = async ({ boardId }) => {
    reads++;
    return boardId === 'board-a' ? pending.promise : { project: project('b'), source: 'board' };
  };
  const first = h.openIde(), repeated = h.openIde();
  assert.equal(first, repeated); assert.equal(reads, 1);
  h.setTarget({ boardId: 'board-b', title: 'B' });
  const latest = await h.openIde();
  pending.resolve({ project: project(), source: 'board' });
  assert.equal((await first).status, 'stale');
  assert.equal(latest.status, 'opened'); assert.equal(latest.reused, false);
  const card = h.document.body.querySelector('.egd-file-card');
  assert.equal(card._fileRecord.project.boardId, 'board-b');
  assert.equal(card._fileView.snapshot().projectId, 'project-b');
  assert.equal(h.document.body.querySelectorAll('.egd-file-card').length, 1); assert.equal(h.pickerCalls(), 0);
  assert.deepEqual(h.runs, []); assert.deepEqual(h.terminalOptions, []);
});

test('IDE never reports opened if the Board binding changed while the new File was becoming ready', async t => {
  for (const replacement of [project('b'), { ...project(), rootId: 'new-root', directoryId: 'new-directory' }]) {
    await t.test(replacement.projectId + ':' + replacement.rootId, async t => {
      const h = await cardFixture(t), entered = deferred(), release = deferred();
      h.projects.set('board-a', project());
      const list = h.service.listDirectory;
      h.service.listDirectory = async request => {
        if (request.directoryId === 'dir-a') { entered.resolve(); await release.promise; }
        return list(request);
      };
      const opening = h.openIde(); await entered.promise;
      h.projects.set('board-a', replacement); release.resolve();
      const result = await opening;
      assert.notEqual(result.status, 'opened');
      assert.equal(h.calls.filter(call => call[0] === 'open').length, 2, 'the Board binding is re-read after readiness');
      const card = h.document.body.querySelector('.egd-file-card');
      assert.equal(card._fileView.snapshot().projectId, 'project-a', 'the already-created card is not relabelled');
      assert.deepEqual(h.focused, []); assert.deepEqual(h.runs, []); assert.deepEqual(h.terminalOptions, []);
    });
  }
});

test('IDE does not reuse an old card when the first Board reply was stale before it arrived', async t => {
  for (const replacement of [project('b'), { ...project(), rootId: 'new-root', directoryId: 'new-directory' }]) {
    await t.test(replacement.projectId + ':' + replacement.rootId, async t => {
      const h = await cardFixture(t), pending = deferred(); let reads = 0;
      h.projects.set('board-a', project());
      const card = await h.spawn({ openMode: 'new', project: project(), projectTarget: { boardId: 'board-a', title: 'A' } });
      await card._fileView.openFile('file-dir-a');
      const editor = card.querySelector('.egdesk-file-editor'); editor.value = 'KEEP'; editor.fire('input'); await card._fileView.flush();
      const before = [structuredClone(card._fileRecord), card._fileView.snapshot(), h.writes.length];
      h.service.openProject = async () => {
        reads++;
        return reads === 1 ? pending.promise : { project: structuredClone(h.projects.get('board-a')), source: 'board' };
      };
      const opening = h.openIde();
      h.projects.set('board-a', replacement);
      pending.resolve({ project: project(), source: 'board' });
      const result = await opening;
      assert.notEqual(result.status, 'opened');
      assert.equal(reads, 2, 'the Board binding is re-read before reusing the card');
      assert.deepEqual([card._fileRecord, card._fileView.snapshot(), h.writes.length], before);
      assert.equal(editor.value, 'KEEP'); assert.deepEqual(h.focused, []);
    });
  }
});

test('IDE does not report a reused card after it closes during the final Board recheck', async t => {
  const h = await cardFixture(t), pending = deferred(); let reads = 0;
  const card = await h.spawn({ openMode: 'new', project: project(), projectTarget: { boardId: 'board-a', title: 'A' } });
  h.service.openProject = async () => {
    reads++;
    if (reads === 1) return { project: project(), source: 'board' };
    return pending.promise;
  };
  const opening = h.openIde(); await until(() => reads === 2);
  card.remove(); pending.resolve({ project: project(), source: 'board' });
  assert.notEqual((await opening).status, 'opened');
  assert.deepEqual(h.focused, []);
});

test('IDE request generations reject A to B to A lookups while honoring the last explicit A click', async t => {
  const h = await cardFixture(t), delayed = deferred(); let firstA = true;
  h.service.openProject = async ({ boardId }) => {
    if (boardId === 'board-a' && firstA) { firstA = false; return delayed.promise; }
    return { project: project(boardId.endsWith('a') ? 'a' : 'b'), source: 'board' };
  };
  const oldest = h.openIde();
  h.setTarget({ boardId: 'board-b', title: 'B' }); const middle = h.openIde();
  h.setTarget({ boardId: 'board-a', title: 'A' }); const newest = h.openIde();
  delayed.resolve({ project: project(), source: 'board' }); const result = await newest;
  assert.equal((await oldest).status, 'stale'); assert.equal((await middle).status, 'stale');
  assert.equal(result.status, 'opened');
  const card = h.document.body.querySelector('.egd-file-card');
  assert.equal(card._fileRecord.project.boardId, 'board-a');
  assert.equal(h.document.body.querySelectorAll('.egd-file-card').length, 1);
});

test('IDE lookup rejects a Board selection A to B to A even without a second IDE click', async t => {
  const h = await cardFixture(t), pending = deferred();
  h.setTarget({ boardId: 'board-a', title: 'A', projectionId: 'projection-a', selectionRevision: 1 });
  h.service.openProject = async () => pending.promise;
  const opening = h.openIde();
  h.setTarget({ boardId: 'board-a', title: 'A', projectionId: 'projection-a', selectionRevision: 3 });
  pending.resolve({ project: project(), source: 'board' });
  assert.equal((await opening).status, 'stale');
  assert.equal(h.document.body.querySelectorAll('.egd-file-card').length, 0);
});

test('IDE no-Board click invalidates the earlier request even if that Board later becomes selected again', async t => {
  const h = await cardFixture(t), pending = deferred();
  h.service.openProject = async () => pending.promise;
  const opening = h.openIde();
  h.setTarget(null); assert.equal((await h.openIde()).status, 'no-board');
  h.setTarget({ boardId: 'board-a', title: 'A 보드' });
  pending.resolve({ project: project(), source: 'board' });
  assert.equal((await opening).status, 'stale');
  assert.equal(h.document.body.querySelectorAll('.egd-file-card').length, 0);
});

test('IDE picker cannot attach after the selected Board changes while the picker is open', async t => {
  const h = await cardFixture(t), pending = deferred();
  h.pick(pending.promise);
  const opening = h.openIde();
  await until(() => h.pickerCalls() === 1);
  h.setTarget({ boardId: 'board-b', title: 'B 보드' });
  pending.resolve('/selected/for/a');
  assert.equal((await opening).status, 'stale');
  assert.equal(h.calls.some(call => call[0] === 'attach'), false);
  assert.equal(h.projects.size, 0); assert.equal(h.document.body.children.length, 0);
  assert.deepEqual(h.runs, []); assert.deepEqual(h.terminalOptions, []);
});

test('IDE keeps native folder selections serial while the latest Board request replaces a stale picker', async t => {
  const h = await cardFixture(t), previousPick = deferred();
  h.pick(previousPick.promise);
  const first = h.openIde(); await until(() => h.pickerCalls() === 1);
  h.setTarget({ boardId: 'board-b', title: 'B 보드' }); h.pick('/selected/for/b');
  const latest = h.openIde();
  await settle();
  assert.equal(h.pickerCalls(), 1, 'another native picker is not opened while the first is pending');
  previousPick.resolve('/selected/for/a');
  assert.equal((await first).status, 'stale');
  assert.equal((await latest).status, 'opened');
  assert.equal(h.pickerCalls(), 2);
  assert.deepEqual(h.calls.filter(call => call[0] === 'attach'), [['attach', 'board-b', 'B 보드']]);
  assert.equal(h.document.body.querySelector('.egd-file-card')._fileRecord.project.boardId, 'board-b');
  assert.deepEqual(h.runs, []); assert.deepEqual(h.terminalOptions, []);
});

test('IDE rechecks the newer Board after an older picker finishes before deciding to pick a folder', async t => {
  const h = await cardFixture(t), previousPick = deferred();
  h.pick(previousPick.promise);
  const first = h.openIde(); await until(() => h.pickerCalls() === 1);
  h.setTarget({ boardId: 'board-b', title: 'B 보드' });
  const latest = h.openIde(); await settle();
  h.projects.set('board-b', project('b'));
  previousPick.resolve('/selected/for/a');
  assert.equal((await first).status, 'stale');
  assert.equal((await latest).status, 'opened');
  assert.equal(h.pickerCalls(), 1, 'the newly verified connection requires no second picker');
  assert.equal(h.calls.some(call => call[0] === 'attach'), false);
  assert.equal(h.document.body.querySelector('.egd-file-card')._fileRecord.project.boardId, 'board-b');
});

test('IDE never reuses a card from another Board even when project and root IDs match', async t => {
  const h = await cardFixture(t), shared = project('a');
  h.projects.set('board-a', shared);
  const other = await h.spawn({ openMode: 'new', project: shared, projectTarget: { boardId: 'board-b', title: 'B' } });
  await other._fileView.openFile('file-dir-a');
  const editor = other.querySelector('.egdesk-file-editor'); editor.value = 'OTHER BOARD'; editor.fire('input');
  await other._fileView.flush();
  const before = [structuredClone(other._fileRecord), other._fileView.snapshot(), h.writes.length];
  const opened = await h.openIde();
  assert.equal(opened.status, 'opened'); assert.equal(opened.reused, false); assert.notEqual(opened.cardId, other.id);
  assert.equal(h.document.body.querySelectorAll('.egd-file-card').length, 2);
  assert.deepEqual([other._fileRecord, other._fileView.snapshot(), h.writes.length], before);
  assert.equal(editor.value, 'OTHER BOARD'); assert.deepEqual(h.focused, []);
  assert.deepEqual(h.runs, []); assert.deepEqual(h.terminalOptions, []);
});

test('ordinary File spawn still activates and reveals a new card and focuses its existing card', async t => {
  const h = await cardFixture(t), card = await h.spawn();
  assert.deepEqual(h.presentations, [{ type: 'spawn', cardId: card.id, activate: true }, { type: 'reveal', cardId: card.id }]);
  assert.equal(await h.spawn(), card);
  assert.deepEqual(h.focused, [card]);
});

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

test('IDE uses the real helper Board project contract, preserving a dirty working copy without executing or saving the original', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-ide-project-flow-'));
  const rootPath = path.join(temp, 'project'), draftDirectory = path.join(temp, 'drafts');
  await fs.mkdir(rootPath); await fs.writeFile(path.join(rootPath, 'source.txt'), 'fixture original\n');
  const adapter = createEGDeskFileHttpAdapter({ draftDirectory, localOwnerScope: 'egdesk-local',
    gitReview: { status: async () => ({ available: false, isRepo: false, entries: [] }) } });
  const requests = [];
  const service = FileView.createEGDeskFileServiceCallbacks({ request: async (pathname, body, options = {}) => {
    requests.push({ pathname, body });
    const headers = { host: '127.0.0.1:39218', 'content-type': 'application/json',
      ...Object.fromEntries(Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value])) };
    return (await adapter.dispatch({ method: 'POST', pathname, body,
      request: { method: 'POST', url: pathname, headers, socket: { remoteAddress: '127.0.0.1' } } })).body;
  } });
  const h = await cardFixture(t, { service });
  t.after(async () => { await adapter.close(); await fs.rm(temp, { recursive: true, force: true }); });
  assert.deepEqual(await service.openProject({ boardId: 'board-a' }), { project: null, source: null });
  h.pick(rootPath);
  const opened = await h.openIde();
  assert.equal(opened.status, 'opened'); assert.equal(opened.reused, false);
  const confirmed = await service.openProject({ boardId: 'board-a' });
  assert.equal(confirmed.source, 'board'); assert.equal(confirmed.project.source, 'board');
  assert.equal(confirmed.project.status, 'connected');
  const card = h.document.body.querySelector('.egd-file-card');
  assert.deepEqual(card._fileRecord.project, { boardId: 'board-a', projectId: confirmed.project.projectId });
  assert.equal(card._fileView.snapshot().rootId, confirmed.project.rootId);
  const listing = await service.listDirectory({ directoryId: confirmed.project.directoryId });
  await card._fileView.openFile(listing.entries.find(entry => entry.name === 'source.txt').id);
  const editor = card.querySelector('.egdesk-file-editor'); editor.value = 'fixture working copy'; editor.fire('input');
  await card._fileView.flush(); editor.selectionStart = 2; editor.selectionEnd = 6; editor.focus();
  const before = card._fileView.snapshot(), requestIndex = requests.length;
  const reused = await h.openIde();
  assert.equal(reused.status, 'opened'); assert.equal(reused.reused, true); assert.equal(reused.cardId, card.id);
  assert.deepEqual(card._fileView.snapshot(), before);
  assert.deepEqual([editor.value, editor.selectionStart, editor.selectionEnd], ['fixture working copy', 2, 6]);
  assert.deepEqual(requests.slice(requestIndex).map(request => request.pathname),
    ['/v1/files/projects/open', '/v1/files/projects/open'], 'reuse verifies the Board binding again before success');
  assert.equal(await fs.readFile(path.join(rootPath, 'source.txt'), 'utf8'), 'fixture original\n');
  assert.equal(requests.some(request => /\/(?:save-original|scripts|script-suggestions|run|terminal)$/.test(request.pathname)), false);
  assert.deepEqual(h.runs, []); assert.deepEqual(h.terminalOptions, []);
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
