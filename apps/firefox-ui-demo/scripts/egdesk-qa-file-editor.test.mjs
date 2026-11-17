import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { FILE_TEXTAREA, FILE_CODE_EDITOR, fileEditorSelectors, readShownFileEditor, chromeWithFileEditor,
  resolveShownFileEditor } from './egdesk-qa-file-editor.mjs';

// Minimal read-only File Card DOM: a textarea model plus an optional mounted
// CodeMirror host whose `.cm-content` holds one `.cm-line` per text line.
export function fakeFileCard({ mode = 'codemirror', text = 'alpha\nbeta', selection = null, focus = null, ready } = {}) {
  const doc = { activeElement: null, defaultView: { getSelection: () => selection ? {
    rangeCount: 1, getRangeAt: () => selection(parts) } : { rangeCount: 0 } } };
  const lines = text.split('\n').map(value => {
    const textNode = { nodeType: 3, data: value };
    return { textNode, textContent: value, classList: { contains: name => name === 'cm-line' },
      contains: node => node === textNode };
  });
  const content = { children: lines, childNodes: lines, ownerDocument: doc,
    contains: node => node === content || lines.some(line => line === node || line.contains(node)) };
  const scroller = { className: 'cm-scroller' };
  const host = { hidden: mode !== 'codemirror', querySelector: selector => ({ '.cm-content': content, '.cm-scroller': scroller })[selector] || null };
  const textarea = { hidden: mode === 'codemirror', value: text, selectionStart: 1, selectionEnd: 3, ownerDocument: doc };
  doc.createRange = () => {
    let line, end = 0;
    return { selectNodeContents(node) { line = node; },
      setEnd(node, at) { end = node === line ? (at ? line.textContent.length : 0) : at; },
      toString: () => line.textContent.slice(0, end) };
  };
  const card = { querySelector: selector => ({ [FILE_TEXTAREA]: textarea, [FILE_CODE_EDITOR]: mode === 'none' ? null : host })[selector] ?? null,
    _fileView: { codeEditorReady: ready ?? Promise.resolve(mode === 'codemirror') } };
  if (mode === 'none') { card.querySelector = () => null; }
  const parts = { doc, lines, content, host, scroller, textarea, card };
  doc.activeElement = focus === 'content' ? content : focus === 'textarea' ? textarea : null;
  return parts;
}

test('file editor selectors target CodeMirror content when shown, else the textarea', () => {
  assert.deepEqual(fileEditorSelectors('#c', 'codemirror'), { mode: 'codemirror',
    input: '#c [data-testid="file-code-editor"] .cm-content', scroll: '#c [data-testid="file-code-editor"] .cm-scroller' });
  assert.deepEqual(fileEditorSelectors('#c', 'textarea'), { mode: 'textarea',
    input: '#c [data-testid="file-editor"]', scroll: '#c [data-testid="file-editor"]' });
  assert.throws(() => fileEditorSelectors('#c', null), /No shown File editor/);
  assert.throws(() => fileEditorSelectors('', 'textarea'), /File Card selector/);
});

test('shown editor reads CodeMirror DOM selection/focus and keeps the textarea model value', () => {
  const all = ({ lines }) => ({ startContainer: lines[0].textNode, startOffset: 0, endContainer: lines[1].textNode, endOffset: 4 });
  const cm = fakeFileCard({ selection: all, focus: 'content' });
  const value = readShownFileEditor(cm.card);
  assert.equal(value.mode, 'codemirror'); assert.equal(value.input, cm.content); assert.equal(value.scroller, cm.scroller);
  assert.equal(value.value, 'alpha\nbeta'); assert.equal(value.shownText, 'alpha\nbeta');
  assert.equal(value.selectionStart, 0); assert.equal(value.selectionEnd, 'alpha\nbeta'.length); assert.equal(value.focused, true);
  // Container-level boundaries (select-all on the content element itself).
  const boundary = fakeFileCard({ selection: ({ content }) => ({ startContainer: content, startOffset: 1, endContainer: content, endOffset: 2 }) });
  assert.deepEqual([readShownFileEditor(boundary.card).selectionStart, readShownFileEditor(boundary.card).selectionEnd], [6, 10]);
  // A selection outside the editor, or none, is not reported as the editor's.
  const outside = fakeFileCard({ selection: () => ({ startContainer: {}, startOffset: 0, endContainer: {}, endOffset: 0 }), focus: 'textarea' });
  assert.deepEqual([readShownFileEditor(outside.card).selectionStart, readShownFileEditor(outside.card).focused], [null, false]);
  assert.equal(readShownFileEditor(fakeFileCard().card).selectionEnd, null);
});

test('shown editor falls back to the textarea when CodeMirror is not mounted', () => {
  const plain = fakeFileCard({ mode: 'textarea', focus: 'textarea' });
  const value = readShownFileEditor(plain.card);
  assert.equal(value.mode, 'textarea'); assert.equal(value.input, plain.textarea); assert.equal(value.scroller, plain.textarea);
  assert.deepEqual([value.value, value.selectionStart, value.selectionEnd, value.focused], ['alpha\nbeta', 1, 3, true]);
  assert.equal(readShownFileEditor(fakeFileCard({ mode: 'none' }).card), null);
  assert.equal(readShownFileEditor(null), null);
});

test('serialized helper runs from source text and resolves per card after the editor load settles', async () => {
  for (const mode of ['codemirror', 'textarea']) {
    const fake = fakeFileCard({ mode });
    const harness = { evaluateChrome: source => runInNewContext(`(${source})()`, {
      document: { querySelectorAll: selector => selector === '#card' ? [fake.card] : [] }, setTimeout, clearTimeout, Promise }) };
    assert.deepEqual(await resolveShownFileEditor(harness, '#card'), fileEditorSelectors('#card', mode));
    assert.equal(await chromeWithFileEditor(harness, () => readShownFileEditor(document.querySelectorAll('#card')[0]).mode), mode);
  }
  // A load that never settles is bounded; the mode then shown is used.
  const hung = fakeFileCard({ mode: 'textarea', ready: new Promise(() => {}) });
  const harness = { evaluateChrome: source => runInNewContext(`(${source})()`, {
    document: { querySelectorAll: () => [hung.card] }, setTimeout, clearTimeout, Promise }) };
  assert.equal((await resolveShownFileEditor(harness, '#card', { loadTimeoutMs: 20 })).mode, 'textarea');
  const none = { evaluateChrome: source => runInNewContext(`(${source})()`, {
    document: { querySelectorAll: () => [] }, setTimeout, clearTimeout, Promise }) };
  await assert.rejects(resolveShownFileEditor(none, '#card'), /expected one File Card, found 0/);
});
