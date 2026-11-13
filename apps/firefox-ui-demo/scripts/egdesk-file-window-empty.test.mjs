import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createEGDeskFileView, egdeskFileViewRegions } from '../overlay/resources/EGDeskFileView.sys.mjs';

// The real File view listeners run against a small unit DOM. No browser,
// helper or OS picker is involved.
class Element {
  constructor(document, tag) {
    this.ownerDocument = document; this.tagName = tag; this.children = []; this.parentElement = null;
    this.attributes = {}; this.listeners = new Map(); this.dataset = {}; this.style = {};
    this.className = ''; this.value = ''; this.hidden = false; this.disabled = false; this.scrollTop = 0;
  }
  set textContent(text) { this.text = String(text); this.replaceChildren(); }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
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
  click() {
    if (this.disabled) return;
    const event = { type: 'click', target: this, preventDefault() {}, stopPropagation() {} };
    for (let node = this; node; node = node.parentElement) for (const callback of node.listeners.get('click') || []) callback(event);
  }
}
function fakeDocument() {
  const document = { createElement: tag => new Element(document, tag), activeElement: null };
  document.body = document.createElement('body');
  return document;
}
const settle = async (turns = 4) => { for (let index = 0; index < turns; index++) await new Promise(resolve => setImmediate(resolve)); };
function fakeService() {
  const drafts = new Map();
  return {
    listDirectory: async ({ directoryId }) => ({ entries: [
      { id: `text-${directoryId}`, name: 'notes.txt', kind: 'file' }, { id: `image-${directoryId}`, name: 'photo.png', kind: 'file' }], nextCursor: null }),
    search: async () => ({ matches: [], truncated: false }),
    readFile: async ({ fileId }) => fileId.startsWith('image-')
      ? { id: fileId, name: 'photo.png', size: 9, sha256: 'b'.repeat(64), diskRevision: 'source-0', kind: 'binary' }
      : { id: fileId, name: 'notes.txt', size: 5, sha256: 'a'.repeat(64), diskRevision: 'source-0', kind: 'text', text: 'start' },
    createDraft: async ({ fileId }) => {
      const id = `draft-${fileId}`;
      if (!drafts.has(id)) drafts.set(id, { id, fileId, rootId: 'root-a', name: 'notes.txt', head: 'h0', text: 'start', baseText: 'start',
        bufferRevision: 0, savedRevision: 0, sourceHash: 'a'.repeat(64), sourceRevision: 'source-0', saveAsAvailable: true });
      return { ...drafts.get(id) };
    },
    readDraft: async ({ draftId }) => ({ ...drafts.get(draftId) }),
    updateDraft: async ({ draftId }) => ({ ...drafts.get(draftId) }),
    saveDraft: async ({ draftId }) => ({ draft: { ...drafts.get(draftId) }, receipt: {} }),
    saveAs: async () => ({}), diffDraft: async () => ({ hunks: [] }),
  };
}
function viewFixture(t, options = {}) {
  const document = fakeDocument();
  const view = createEGDeskFileView({ document, service: fakeService(), parts: { diffView: null, runResult: null, changeReview: null },
    chooseRoot: async () => ({ rootId: 'root-a', directoryId: 'dir-a', name: '보고서 폴더' }), chooseSaveAs: async () => null, ...options });
  document.body.append(view.element); t.after(() => view.close());
  return { view, find: selector => view.element.querySelector(selector) };
}
const shown = (h, selector) => { const node = h.find(selector); assert.ok(node, `${selector} exists`); return !node.closest('[hidden]'); };

test('File window regions: nothing but the connect prompt before a folder, save and compare only for an editable file', () => {
  assert.deepEqual({ ...egdeskFileViewRegions() },
    { state: 'empty', empty: true, search: false, treePanel: false, workspace: false, details: false, actions: false });
  assert.deepEqual({ ...egdeskFileViewRegions({ connected: true }) },
    { state: 'connected', empty: false, search: true, treePanel: true, workspace: true, details: false, actions: false });
  assert.deepEqual({ ...egdeskFileViewRegions({ connected: true, hasFile: true, editable: true }) },
    { state: 'connected', empty: false, search: true, treePanel: true, workspace: true, details: true, actions: true });
  assert.equal(egdeskFileViewRegions({ connected: true, hasFile: true, editable: false }).actions, false, 'a read-only format has nothing to save');
  assert.equal(egdeskFileViewRegions({ connected: true, hasFile: false, editable: true }).actions, false, 'no file, no save or compare');
  // A restored working copy whose folder is not connected again: the copy stays
  // usable and the connect buttons stay reachable, but there is nothing to find.
  assert.deepEqual({ ...egdeskFileViewRegions({ connected: false, hasFile: true, editable: true }) },
    { state: 'unconnected', empty: false, search: false, treePanel: false, workspace: true, details: true, actions: true });
  assert.ok(Object.isFrozen(egdeskFileViewRegions()));
});

test('a new File window shows one prompt and the connect buttons, with no search, tabs, save or compare', async t => {
  const h = viewFixture(t, { getProjectTarget: () => ({ boardId: 'board-a', title: '보고서' }), chooseProject: async () => null });
  assert.equal(h.view.element.dataset.fileState, 'empty');
  assert.equal(shown(h, '.egdesk-file-empty'), true);
  assert.equal(h.find('.egdesk-file-empty-hint').textContent, '폴더를 연결하면 이 창에서 파일을 찾아 열고 고칠 수 있습니다.');
  assert.equal(h.find('.egdesk-file-empty').getAttribute('role'), null, 'a static prompt is not announced as a status');
  assert.equal(shown(h, '.egdesk-file-connect'), true);
  assert.equal(shown(h, '.egdesk-file-project-connect'), true);
  for (const selector of ['.egdesk-file-search', '.egdesk-file-tabs', '.egdesk-file-tree-panel', '.egdesk-file-workspace', '.egdesk-file-title',
    '.egdesk-file-details', '.egdesk-file-actions', '.egdesk-file-review-button', '.egdesk-file-save-button', '.egdesk-file-save-as-button']) {
    assert.equal(shown(h, selector), false, `${selector} is not shown before a folder is connected`);
  }
  // Order in the document follows the reading order: prompt, then its buttons.
  assert.deepEqual(h.view.element.children.slice(0, 2).map(node => node.className), ['egdesk-file-empty', 'egdesk-file-toolbar']);
});

test('connecting a folder brings search and tabs; save and compare wait for a chosen text file', async t => {
  const h = viewFixture(t);
  h.find('.egdesk-file-connect').click(); await settle();
  assert.equal(h.view.snapshot().rootId, 'root-a');
  assert.equal(h.view.element.dataset.fileState, 'connected');
  assert.equal(shown(h, '.egdesk-file-empty'), false);
  for (const selector of ['.egdesk-file-search', '.egdesk-file-tabs', '.egdesk-file-tree-panel', '.egdesk-file-workspace', '.egdesk-file-title']) {
    assert.equal(shown(h, selector), true, `${selector} appears with a connected folder`);
  }
  assert.equal(h.find('.egdesk-file-title').textContent, '보고서 폴더');
  for (const selector of ['.egdesk-file-details', '.egdesk-file-actions', '.egdesk-file-review-button', '.egdesk-file-save-button']) {
    assert.equal(shown(h, selector), false, `${selector} waits for a file`);
  }

  assert.equal(await h.view.openFile('text-dir-a'), true);
  assert.equal(shown(h, '.egdesk-file-details'), true);
  for (const selector of ['.egdesk-file-actions', '.egdesk-file-review-button', '.egdesk-file-save-button', '.egdesk-file-save-as-button']) {
    assert.equal(shown(h, selector), true, `${selector} appears for the chosen text file`);
  }

  assert.equal(await h.view.openFile('image-dir-a'), true);
  assert.equal(shown(h, '.egdesk-file-details'), true, 'file information stays for a read-only format');
  assert.equal(shown(h, '.egdesk-file-actions'), false, 'a read-only format offers no save or compare');

  // Connecting another folder drops the file: its stale information goes too.
  h.find('.egdesk-file-connect').click(); await settle();
  assert.equal(h.view.snapshot().fileId, null);
  assert.equal(shown(h, '.egdesk-file-details'), false);
  assert.equal(shown(h, '.egdesk-file-actions'), false);
  assert.equal(h.view.element.dataset.fileState, 'connected');
});

test('the tabs are a tab strip with a selected state and the heading no longer repeats the first tab', async t => {
  const h = viewFixture(t);
  h.find('.egdesk-file-connect').click(); await settle();
  const [files, changes] = h.find('.egdesk-file-tabs').querySelectorAll('.egdesk-file-tab');
  assert.equal(files.getAttribute('role'), 'tab'); assert.equal(files.getAttribute('aria-selected'), 'true');
  assert.equal(changes.getAttribute('aria-selected'), 'false');
  assert.equal(changes.disabled, true, 'no change view is connected in this fixture');
  assert.equal(h.find('.egdesk-file-tree-heading').className.split(' ').includes('egdesk-file-visually-hidden'), true,
    'the panel keeps its heading for assistive technology without printing "파일" twice');
});

const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
const declarations = selector => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blocks = [...css.matchAll(new RegExp(`(?:^|[},])\\s*${escaped}\\s*(?:,[^{]*)?\\{([^}]*)\\}`, 'gm'))].map(match => match[1]);
  assert.ok(blocks.length > 0, `missing CSS rule ${selector}`);
  return blocks.join(';');
};

test('File window CSS uses the shared font, token buttons and inputs, and a centred empty state', () => {
  assert.match(declarations('.egdesk-file-view'), /font:\s*13px\/1\.5 var\(--egd-font\)/);
  assert.doesNotMatch(declarations('.egdesk-file-view'), /sans-serif/);
  const button = declarations('.egdesk-file-view button');
  assert.match(button, /border:\s*1px solid var\(--egd-outline\)/);
  assert.match(button, /background:\s*var\(--egd-surface-elevated\)/);
  assert.match(button, /min-height:\s*28px/);
  assert.match(declarations('.egdesk-file-view button:hover:not(:disabled)'), /background:\s*var\(--egd-hover\)/);
  const focus = declarations('.egdesk-file-view button:focus-visible');
  assert.match(focus, /outline:\s*var\(--egd-focus-outline\)/);
  assert.match(focus, /outline-offset:\s*var\(--egd-focus-outline-offset\)/);
  assert.match(declarations('.egdesk-file-view button:disabled'), /opacity:\s*var\(--egd-opacity-disabled\)/);

  const input = declarations('.egdesk-file-search-input');
  assert.match(input, /border:\s*1px solid var\(--egd-outline\)/);
  assert.match(input, /background:\s*var\(--egd-surface-elevated\)/);
  assert.match(declarations('.egdesk-file-search-input:focus-visible'), /border-color:\s*var\(--egd-focus-border\)/);

  // Tabs: a strip on one bottom line, the selected tab marked by ink and an underline.
  assert.match(declarations('.egdesk-file-tabs'), /border-bottom:\s*1px solid var\(--egd-outline-variant\)/);
  assert.match(declarations('.egdesk-file-view .egdesk-file-tab'), /border-radius:\s*0/);
  assert.match(declarations('.egdesk-file-view .egdesk-file-tab[aria-selected="true"]'), /border-bottom-color:\s*var\(--egd-primary\)/);

  // Empty state: the prompt sits directly above one filled button.
  assert.match(declarations('.egdesk-file-view[data-file-state="empty"]'), /grid-template-rows:\s*minmax\(0, 1fr\) minmax\(0, 1fr\) auto auto/);
  assert.match(declarations('.egdesk-file-view[data-file-state="empty"] .egdesk-file-toolbar'), /justify-content:\s*center/);
  const primary = declarations('.egdesk-file-view[data-file-state="empty"] .egdesk-file-connect');
  assert.match(primary, /background:\s*var\(--egd-primary\)/);
  assert.match(primary, /color:\s*var\(--egd-on-primary\)/);
  const secondary = declarations('.egdesk-file-view[data-file-state="empty"] .egdesk-file-project-connect');
  assert.match(secondary, /background:\s*transparent/);
  assert.match(secondary, /border-color:\s*transparent/);

  // No literal colours in the File block: tokens only.
  const start = css.indexOf('.egdesk-file-view {'), end = css.indexOf('.egdesk-file-error {');
  assert.ok(start > 0 && end > start);
  assert.doesNotMatch(css.slice(start, end), /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
});
