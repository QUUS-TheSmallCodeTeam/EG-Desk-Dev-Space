// CODE-04: the vendored CodeMirror 6 bundle and the File view editor adapter
// (EGDeskCodeEditor) with its textarea fallback.
// Run: node --test apps/firefox-ui-demo/scripts/egdesk-code-editor.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import * as Code from '../overlay/resources/EGDeskCodeEditor.sys.mjs'
import * as FileView from '../overlay/resources/EGDeskFileView.sys.mjs'

const resources = new URL('../overlay/resources/', import.meta.url)
const vendor = new URL('vendor/', resources)

// ============================ vendor / licences ============================

test('vendored CodeMirror bundle is byte-identical to its VENDOR.md record', () => {
  const record = readFileSync(new URL('VENDOR.md', vendor), 'utf8')
  assert.match(record, /\| CodeMirror 6 \(`codemirror` 묶음\) \| 6\.0\.2 .*\| MIT \|/)
  const listed = new Map([...record.matchAll(/^\| `(codemirror\/[^`]+)` \| `([0-9a-f]{64})` \|$/gm)].map(([, file, hash]) => [file, hash]))
  const files = readdirSync(new URL('codemirror/', vendor)).map(name => `codemirror/${name}`).sort()
  assert.deepEqual(files, [...listed.keys()].sort(), 'every vendored file is listed, and nothing else is there')
  for (const file of files) {
    assert.equal(createHash('sha256').update(readFileSync(new URL(file, vendor))).digest('hex'), listed.get(file), `${file} is unmodified`)
  }
  // Every directly pinned package and its exact version is recorded.
  for (const [name, version] of [['codemirror', '6.0.2'], ['@codemirror/state', '6.7.6'], ['@codemirror/view', '6.43.15'], ['@codemirror/commands', '6.11.1'],
    ['@codemirror/language', '6.13.1'], ['@codemirror/search', '6.7.2'], ['@codemirror/lang-javascript', '6.2.5'], ['@codemirror/lang-json', '6.0.2'],
    ['@codemirror/lang-css', '6.3.1'], ['@codemirror/lang-html', '6.4.12'], ['@codemirror/lang-markdown', '6.5.2'], ['@codemirror/lang-python', '6.2.1']]) {
    assert.ok(record.includes(`| \`${name}\` | ${version} | MIT |`), `${name}@${version} recorded`)
    assert.ok(record.includes(`${name}@${version}`), `${name}@${version} in the rebuild command`)
  }
  assert.match(record, /esbuild entry\.mjs --bundle --format=esm --minify --legal-comments=none/)
  const licence = readFileSync(new URL('codemirror/LICENSE', vendor), 'utf8')
  assert.match(licence, /==== @codemirror\/view@6\.43\.15 ====\nMIT License\n\nCopyright \(C\) 2018-2021 by Marijn Haverbeke/)
  assert.equal((licence.match(/^==== /gm) || []).length, 26)
})

test('the bundle is self-contained browser ESM that exports what the adapter needs', async () => {
  const source = readFileSync(new URL('codemirror/codemirror.bundle.mjs', vendor), 'utf8')
  assert.equal(/\brequire\(|from ['"]node:|^import\b|\bimport\(/m.test(source), false, 'no imports of any kind')
  const bundle = await import(new URL('codemirror/codemirror.bundle.mjs', vendor).href)
  for (const name of ['EditorState', 'EditorView', 'Compartment', 'lineNumbers', 'history', 'undo', 'redo', 'search', 'openSearchPanel', 'searchKeymap',
    'syntaxHighlighting', 'HighlightStyle', 'tags', 'javascript', 'json', 'css', 'html', 'markdown', 'python']) {
    assert.ok(bundle[name], `exports ${name}`)
  }
})

// ============================ fakes ============================

class FakeElement {
  constructor(document, tag) {
    this.ownerDocument = document; this.tagName = tag; this.children = []; this.parentElement = null; this.attributes = {}
    this.listeners = new Map(); this.dataset = {}; this.className = ''; this.value = ''; this.hidden = false; this.disabled = false
    this.readOnly = false; this.scrollTop = 0; this.selection = null
  }
  set textContent(text) { this.text = String(text); this.replaceChildren() }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join('') }
  get isConnected() { return this === this.ownerDocument.body || !!this.parentElement?.isConnected }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child) } }
  appendChild(child) { this.append(child); return child }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children) }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null }
  setAttribute(key, value) { this.attributes[key] = String(value) }
  getAttribute(key) { return this.attributes[key] ?? null }
  removeAttribute(key) { delete this.attributes[key] }
  addEventListener(type, callback) { this.listeners.set(type, [...(this.listeners.get(type) || []), callback]) }
  matches(selector) {
    if (selector === '[hidden]') return this.hidden
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1))
    return this.tagName === selector
  }
  closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null }
  contains(child) { for (let node = child; node; node = node.parentElement) if (node === this) return true; return false }
  querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null }
  focus() { this.ownerDocument.activeElement = this }
  setSelectionRange(start, end) { this.selection = [start, end] }
  fire(type) { for (let node = this; node; node = node.parentElement) for (const callback of node.listeners.get(type) || []) callback({ type, target: this, preventDefault() {}, stopPropagation() {} }) }
  click() { if (!this.disabled) this.fire('click') }
}
function fakeDocument() {
  const document = { createElement: tag => new FakeElement(document, tag), activeElement: null }
  document.body = document.createElement('body')
  return document
}

// A fake CodeMirror bundle with the same API shape the adapter uses. It keeps
// the document as a string and runs update listeners on every dispatch.
function fakeBundle({ failConstruct = false } = {}) {
  const calls = []
  const views = []
  const doc = text => ({
    toString: () => text, length: text.length, lines: text.split('\n').length,
    line: n => { const r = Code.lineRange(text, n); return { from: r.start, to: r.end, number: r.line } },
  })
  class Compartment { of(ext) { return { slot: this, ext } } reconfigure(ext) { return { reconfigure: this, ext } } }
  const flat = list => list.flat(Infinity)
  const EditorState = {
    create: ({ doc: text, extensions }) => ({ doc: doc(String(text)), extensions: flat(extensions) }),
    readOnly: { of: value => ({ readOnly: value }) },
    phrases: { of: phrases => ({ phrases }) },
  }
  class EditorView {
    static theme(spec) { return { theme: spec } }
    static updateListener = { of: listener => ({ updateListener: listener }) }
    static domEventHandlers(handlers) { return { domEventHandlers: handlers } }
    static editable = { of: value => ({ editable: value }) }
    static contentAttributes = { of: attrs => ({ contentAttributes: attrs }) }
    static scrollIntoView(pos, options) { return { scrollIntoView: pos, options } }
    constructor({ state, parent }) {
      if (failConstruct) throw new Error('no window')
      this.parent = parent; this.scrollDOM = { scrollTop: 0 }; this.composing = false; this.focused = 0; this.selection = null; this.effects = []
      this.dom = parent.ownerDocument.createElement('div'); this.dom.className = 'cm-editor'; parent.append(this.dom)
      this.setState(state); this.stateCount = 1; views.push(this)
    }
    setState(state) {
      this.state = state; this.stateCount = (this.stateCount || 0) + 1
      this.slots = new Map(state.extensions.filter(ext => ext?.slot).map(ext => [ext.slot, ext.ext]))
    }
    ext(key) { return this.state.extensions.filter(ext => ext && key in ext).map(ext => ext[key]) }
    slotValue(index) { return [...this.slots.values()][index] }
    dispatch(tr) {
      let docChanged = false
      if (tr.changes) {
        const old = this.state.doc.toString(), { from, to, insert } = tr.changes
        this.state = { ...this.state, doc: doc(old.slice(0, from) + insert + old.slice(to)) }; docChanged = true
      }
      if (tr.selection) this.selection = tr.selection
      for (const effect of [tr.effects].flat().filter(Boolean)) {
        if (effect.reconfigure) this.slots.set(effect.reconfigure, effect.ext); else this.effects.push(effect)
      }
      for (const listener of this.ext('updateListener')) listener({ docChanged, state: this.state, view: this })
    }
    // Test helper: what a user keystroke does.
    type(text, at = this.state.doc.length) { this.dispatch({ changes: { from: at, to: at, insert: text } }) }
    dom_(type) { for (const handlers of this.ext('domEventHandlers')) handlers[type]?.({ type }, this) }
    focus() { this.focused++ }
    destroy() { this.destroyed = true }
  }
  const tag = name => ({ tag: name })
  const tags = new Proxy({}, { get: (_, name) => name === 'function' || name === 'definition' || name === 'special'
    ? inner => ({ tag: name + '(' + inner.tag + ')' }) : tag(name) })
  const ext = name => (...args) => ({ ext: name, args })
  const bundle = {
    Compartment, EditorState, EditorView, tags,
    keymap: { of: bindings => ({ keymap: bindings }) },
    defaultKeymap: ['default'], historyKeymap: ['history'], searchKeymap: ['search'], foldKeymap: ['fold'],
    HighlightStyle: { define: spec => ({ highlight: spec }) }, defaultHighlightStyle: { defaultHighlight: true },
    undo: view => { calls.push(['undo', view]); return true }, redo: view => { calls.push(['redo', view]); return true },
    openSearchPanel: view => { calls.push(['search', view]); return true },
  }
  for (const name of ['lineNumbers', 'highlightActiveLineGutter', 'highlightSpecialChars', 'history', 'foldGutter', 'drawSelection', 'indentOnInput',
    'bracketMatching', 'highlightActiveLine', 'highlightSelectionMatches', 'search', 'syntaxHighlighting', 'javascript', 'json', 'css', 'html', 'markdown', 'python']) bundle[name] = ext(name)
  return { bundle, calls, views }
}
function adapterFixture(options = {}) {
  const document = fakeDocument()
  const label = document.createElement('label'), textarea = document.createElement('textarea'), host = document.createElement('div')
  label.append(textarea, host); document.body.append(label)
  const editor = Code.createEGDeskCodeEditor({ textarea, host, ...options })
  const events = []
  for (const type of ['input', 'compositionstart', 'compositionend']) editor.on(type, () => events.push(type))
  return { document, textarea, host, editor, events }
}

// ============================ pure helpers ============================

test('syntax highlighting is chosen by the file extension', () => {
  const cases = { 'a.js': 'javascript', 'EGDeskFileView.sys.mjs': 'javascript', 'x.cjs': 'javascript', 'v.jsx': 'jsx', 't.ts': 'typescript', 'c.TSX': 'tsx',
    'package.json': 'json', 'site.css': 'css', 'index.html': 'html', 'README.md': 'markdown', 'run.py': 'python', 'notes.txt': null, Makefile: null, '': null, 'archive.tar.gz': null }
  for (const [name, language] of Object.entries(cases)) assert.equal(Code.codeLanguageForName(name), language, name)
})

test('lineRange finds a 1-based line and clamps past the end', () => {
  assert.deepEqual(Code.lineRange('one\ntwo\nthree', 2), { line: 2, start: 4, end: 7 })
  assert.deepEqual(Code.lineRange('one\ntwo\nthree', 3), { line: 3, start: 8, end: 13 })
  assert.deepEqual(Code.lineRange('one\ntwo', 99), { line: 2, start: 4, end: 7 })
  assert.deepEqual(Code.lineRange('', 1), { line: 1, start: 0, end: 0 })
})

test('theme colors come only from --egd-* tokens (light and dark follow the Desk theme)', () => {
  const values = Object.values(Code.EGDESK_CODE_EDITOR_THEME).flatMap(rule => Object.entries(rule))
  for (const [key, value] of values) {
    if (/color|background|^border$|borderRight|borderBottom|^outline$/i.test(key)) assert.match(value, /var\(--egd-[a-z0-9-]+\)|^none$/, key + ': ' + value)
    assert.equal(/#[0-9a-f]{3,8}\b|rgb|hsl/i.test(value), false, key + ' has no literal color')
  }
  const spec = Code.egdeskHighlightSpec(fakeBundle().bundle.tags)
  assert.ok(spec.length >= 10)
  for (const rule of spec) if (rule.color) assert.match(rule.color, /^var\(--egd-/)
  assert.ok(spec.some(rule => rule.tag.some(tag => tag.tag === 'function(variableName)')))
  // Unknown tag names are dropped instead of breaking the editor.
  assert.deepEqual(Code.egdeskHighlightSpec({}), [])
})

test('search and gutter phrases are Korean', () => {
  assert.equal(Code.EGDESK_CODE_EDITOR_PHRASES.Find, '찾기')
  assert.equal(Code.EGDESK_CODE_EDITOR_PHRASES['replace all'], '모두 바꾸기')
  for (const value of Object.values(Code.EGDESK_CODE_EDITOR_PHRASES)) assert.match(value, /[가-힣]/)
})

// ============================ textarea fallback ============================

test('without a window ChromeUtils the bundle is not loaded and the textarea stays', async () => {
  assert.equal(Code.loadEGDeskCodeEditorBundle(fakeDocument()), null)
  assert.equal(Code.loadEGDeskCodeEditorBundle({ defaultView: { ChromeUtils: { importESModule() { throw new Error('missing') } } } }), null)
  const seen = []
  const loaded = Code.loadEGDeskCodeEditorBundle({ defaultView: { ChromeUtils: { importESModule: (url, options) => { seen.push([url, options]); return { ok: 1 } } } } })
  assert.deepEqual(loaded, { ok: 1 })
  assert.match(seen[0][0], /\/vendor\/codemirror\/codemirror\.bundle\.mjs$/)
  assert.deepEqual(seen[0][1], { global: 'current' })
})

for (const [name, loadBundle] of [['returns null', () => null], ['throws', () => { throw new Error('blocked') }], ['rejects', async () => { throw new Error('blocked') }],
  ['is not CodeMirror', () => ({ EditorView: 1 })], ['view constructor fails', () => fakeBundle({ failConstruct: true }).bundle]]) {
  test('fallback when the bundle ' + name + ': the textarea edits, jumps and locks', async () => {
    const h = adapterFixture({ loadBundle })
    h.textarea.value = 'one\ntwo\nthree'
    assert.equal(await h.editor.mount(), false)
    assert.equal(h.editor.mode, 'textarea')
    assert.equal(h.textarea.hidden, false)
    assert.equal(h.host.hidden, true)
    assert.equal(h.host.children.length, 0)
    h.editor.setText('alpha\nbeta\ngamma')
    assert.equal(h.textarea.value, 'alpha\nbeta\ngamma')
    assert.equal(h.editor.revealLine(2), 2)
    assert.deepEqual(h.textarea.selection, [6, 10])
    assert.equal(h.document.activeElement, h.textarea)
    assert.equal(h.editor.revealLine(0), 0)
    h.editor.setReadOnly(true)
    assert.equal(h.textarea.readOnly, true)
    assert.equal(h.editor.undo(), false)
    h.editor.scrollTop = 30
    assert.equal(h.textarea.scrollTop, 30)
    assert.equal(h.editor.setLanguage('a.py'), 'python')
    assert.deepEqual(h.events, [], 'external text changes are not user input')
  })
}

// ============================ CodeMirror adapter ============================

test('CodeMirror takes over the textarea and mirrors user edits into it', async () => {
  const f = fakeBundle()
  const h = adapterFixture({ loadBundle: () => f.bundle })
  h.textarea.value = 'typed before load'
  h.textarea.focus()
  assert.equal(await h.editor.mount(), true)
  assert.equal(await h.editor.mount(), true, 'mount is idempotent')
  const [view] = f.views
  assert.equal(f.views.length, 1)
  assert.equal(h.editor.mode, 'codemirror')
  assert.equal(h.textarea.hidden, true)
  assert.equal(h.host.hidden, false)
  assert.equal(view.parent, h.host)
  assert.equal(view.state.doc.toString(), 'typed before load')
  assert.equal(view.focused, 1, 'focus moves with the swap')
  // Feature set: line numbers, history, search, highlighting, Korean label.
  const kinds = view.state.extensions.map(ext => ext?.ext).filter(Boolean)
  for (const kind of ['lineNumbers', 'history', 'search', 'syntaxHighlighting', 'highlightSelectionMatches']) assert.ok(kinds.includes(kind), kind)
  assert.deepEqual(view.ext('contentAttributes')[0]['aria-label'], '텍스트 작업사본')
  assert.equal(view.ext('phrases')[0], Code.EGDESK_CODE_EDITOR_PHRASES)
  assert.deepEqual(view.ext('keymap')[0], ['default', 'history', 'search', 'fold'], 'no Tab-indent keyboard trap')
  view.type('!')
  assert.equal(h.textarea.value, 'typed before load!')
  assert.deepEqual(h.events, ['input'])
})

test('opening another file resets the text and undo history without reporting input', async () => {
  const f = fakeBundle()
  const h = adapterFixture({ loadBundle: () => f.bundle })
  await h.editor.mount()
  const [view] = f.views
  const before = view.stateCount
  h.editor.setText('fresh file')
  assert.equal(view.stateCount, before + 1, 'a new EditorState (fresh history)')
  assert.equal(view.state.doc.toString(), 'fresh file')
  assert.equal(h.textarea.value, 'fresh file')
  h.editor.setText('kept newer text', { keepHistory: true })
  assert.equal(view.stateCount, before + 1, 'kept the same state history')
  assert.equal(view.state.doc.toString(), 'kept newer text')
  assert.deepEqual(h.events, [])
})

test('language, read-only mode, undo/redo and search go through CodeMirror', async () => {
  const f = fakeBundle()
  const h = adapterFixture({ loadBundle: () => f.bundle })
  await h.editor.mount()
  const [view] = f.views
  assert.equal(h.editor.setLanguage('app.tsx'), 'tsx')
  assert.deepEqual(view.slotValue(0), { ext: 'javascript', args: [{ typescript: true, jsx: true }] })
  h.editor.setLanguage('notes.txt')
  assert.deepEqual(view.slotValue(0), [])
  h.editor.setText('x')
  assert.deepEqual(view.slotValue(0), [], 'language survives a state reset')
  h.editor.setLanguage('a.json'); h.editor.setText('{}')
  assert.deepEqual(view.slotValue(0), { ext: 'json', args: [] })
  assert.deepEqual(view.slotValue(1), [{ readOnly: false }, { editable: true }])
  h.editor.setReadOnly(true)
  assert.deepEqual(view.slotValue(1), [{ readOnly: true }, { editable: false }])
  assert.equal(h.textarea.readOnly, true)
  assert.equal(h.editor.undo(), false, 'read-only blocks undo')
  assert.equal(h.editor.openSearch(), true, 'search still opens')
  h.editor.setReadOnly(false)
  assert.equal(h.editor.undo(), true)
  assert.equal(h.editor.redo(), true)
  assert.deepEqual(f.calls.map(([name, target]) => [name, target === view]), [['search', true], ['undo', true], ['redo', true]])
})

test('revealLine selects the line, centers it and focuses (clamped)', async () => {
  const f = fakeBundle()
  const h = adapterFixture({ loadBundle: () => f.bundle })
  await h.editor.mount()
  const [view] = f.views
  h.editor.setText('one\ntwo\nthree')
  assert.equal(h.editor.revealLine(2), 2)
  assert.deepEqual(view.selection, { anchor: 4, head: 7 })
  assert.deepEqual(view.effects.at(-1), { scrollIntoView: 4, options: { y: 'center' } })
  assert.equal(h.editor.revealLine(40), 3)
  assert.deepEqual(view.selection, { anchor: 8, head: 13 })
  assert.equal(h.editor.revealLine(-1), 0)
  view.scrollDOM.scrollTop = 120
  assert.equal(h.editor.scrollTop, 120)
})

test('IME composition is forwarded so the File view holds its flush', async () => {
  const f = fakeBundle()
  const h = adapterFixture({ loadBundle: () => f.bundle })
  await h.editor.mount()
  const [view] = f.views
  view.dom_('compositionstart'); view.type('ㅎ'); view.dom_('compositionend')
  assert.deepEqual(h.events, ['compositionstart', 'input', 'compositionend'])
})

test('a load finishing during textarea IME composition waits for it to end', async () => {
  const f = fakeBundle()
  const h = adapterFixture({ loadBundle: () => f.bundle })
  h.textarea.fire('compositionstart')
  const mounting = h.editor.mount()
  await new Promise(resolve => setTimeout(resolve, 80))
  assert.equal(h.editor.mode, 'textarea')
  h.textarea.value = '한글'
  h.textarea.fire('compositionend')
  assert.equal(await mounting, true)
  assert.equal(f.views[0].state.doc.toString(), '한글')
})

// ============================ File view wiring ============================

function fileFixture(t, { loadCodeEditor, saveOriginal } = {}) {
  const writes = []
  let text = 'line one\nline two\nline three'
  const draft = { id: 'draft-1', fileId: 'file-1', rootId: 'root-1', name: 'app.js', head: 'h0', text, baseText: text, bufferRevision: 0, savedRevision: 0,
    sourceHash: 'a'.repeat(64), sourceRevision: 'rev-0', saveAsAvailable: false }
  const service = {
    listDirectory: async () => ({ entries: [{ id: 'file-1', name: 'app.js', kind: 'file' }], nextCursor: null }),
    search: async () => ({ matches: [], truncated: false }),
    readFile: async () => ({ id: 'file-1', fileId: 'file-1', name: 'app.js', size: text.length, sha256: 'a'.repeat(64), diskRevision: 'rev-0', kind: 'text', text }),
    createDraft: async () => ({ ...draft }),
    updateDraft: async ({ text: next }) => { writes.push(next); draft.text = next; draft.head = 'h' + writes.length; draft.bufferRevision = writes.length; return { ...draft } },
    saveDraft: async () => ({ draft: { ...draft }, receipt: {} }), saveAs: async () => ({}), diffDraft: async () => ({ hunks: [] }),
    ...(saveOriginal ? { saveOriginal } : {}),
  }
  const document = fakeDocument()
  const view = FileView.createEGDeskFileView({ document, service, parts: { diffView: null, runResult: null, changeReview: null }, loadCodeEditor })
  document.body.append(view.element)
  t.after(() => view.close())
  return { view, writes, document, setDisk: value => { text = value } }
}
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

test('File view: CodeMirror edits drive dirty state, the draft flush and jump-to-line', async t => {
  const f = fakeBundle()
  const h = fileFixture(t, { loadCodeEditor: () => f.bundle })
  assert.equal(await h.view.codeEditorReady, true)
  assert.equal(h.view.editorMode, 'codemirror')
  await h.view.openRoot({ rootId: 'root-1', directoryId: 'dir-1', name: 'proj' })
  assert.equal(await h.view.openFile('file-1'), true)
  const [view] = f.views
  assert.equal(view.state.doc.toString(), 'line one\nline two\nline three')
  assert.deepEqual(view.slotValue(0), { ext: 'javascript', args: [] }, 'highlighting by extension')
  assert.equal(h.view.snapshot().dirty, false)
  view.type(' edited')
  assert.equal(h.view.snapshot().dirty, true)
  assert.equal(h.view.snapshot().originalDirty, true)
  await wait(320)
  assert.deepEqual(h.writes, ['line one\nline two\nline three edited'])
  assert.equal(h.view.snapshot().dirty, true, 'saved to the draft, original untouched (D-X1)')
  assert.equal(h.view.revealLine(2), true)
  assert.deepEqual(view.selection, { anchor: 9, head: 17 })
  h.view.setReadOnly(true)
  assert.deepEqual(view.slotValue(1), [{ readOnly: true }, { editable: false }])
})

test('File view: SOURCE_CHANGED compare shows the CodeMirror text, never overwriting silently', async t => {
  const f = fakeBundle()
  const attempts = []
  const h = fileFixture(t, { loadCodeEditor: () => f.bundle, saveOriginal: async request => {
    attempts.push(request)
    throw Object.assign(new Error('changed'), { code: 'SOURCE_CHANGED', details: { currentSourceHash: 'b'.repeat(64) } })
  } })
  await h.view.codeEditorReady
  await h.view.openRoot({ rootId: 'root-1', directoryId: 'dir-1', name: 'proj' })
  await h.view.openFile('file-1')
  f.views[0].type('\nmine')
  h.setDisk('someone else')
  assert.equal(await h.view.saveOriginal(), null)
  assert.equal(attempts.length, 1)
  assert.equal(attempts[0].expectedSourceHash, undefined, 'first save carries no overwrite permission')
  assert.deepEqual(h.writes, ['line one\nline two\nline three\nmine'], 'flushed the CodeMirror text before saving')
  const panel = h.view.element.querySelector('.egdesk-file-source-conflict')
  assert.equal(panel.hidden, false)
  assert.match(panel.textContent, /원본이 열 때와 다릅니다/)
  assert.match(panel.textContent, /mine/)
  assert.match(panel.textContent, /someone else/)
})

test('File view: without the bundle the textarea fallback still edits and saves', async t => {
  const h = fileFixture(t, {})
  assert.equal(await h.view.codeEditorReady, false)
  assert.equal(h.view.editorMode, 'textarea')
  await h.view.openRoot({ rootId: 'root-1', directoryId: 'dir-1', name: 'proj' })
  await h.view.openFile('file-1')
  const textarea = h.view.element.querySelector('.egdesk-file-editor')
  assert.equal(textarea.hidden, false)
  assert.equal(textarea.value, 'line one\nline two\nline three')
  textarea.value += '!'
  textarea.fire('input')
  assert.equal(h.view.snapshot().dirty, true)
  await wait(320)
  assert.deepEqual(h.writes, ['line one\nline two\nline three!'])
  assert.equal(h.view.revealLine(3), true)
  assert.deepEqual(textarea.selection, [18, 29])
})
