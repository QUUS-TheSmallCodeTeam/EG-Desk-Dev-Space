// QA-only targeting for the File view editor. Once CodeMirror 6 loads, the
// `file-editor` textarea is hidden and stays as the text model; the visible,
// editable surface is `.cm-content` inside `file-code-editor`. Without the
// bundle the textarea is still the shown editor. Native input must go to the
// surface that is actually shown; `.value` reads keep using the textarea.

export const FILE_TEXTAREA = '[data-testid="file-editor"]';
export const FILE_CODE_EDITOR = '[data-testid="file-code-editor"]';

// Selectors for one card's shown editor. `input` receives native typing and
// keys; `scroll` is the element whose scroll position the user sees.
export function fileEditorSelectors(cardSelector, mode) {
  if (typeof cardSelector !== 'string' || !cardSelector) throw new Error('A File Card selector is required');
  if (mode === 'codemirror') {
    return { mode, input: `${cardSelector} ${FILE_CODE_EDITOR} .cm-content`, scroll: `${cardSelector} ${FILE_CODE_EDITOR} .cm-scroller` };
  }
  if (mode === 'textarea') return { mode, input: `${cardSelector} ${FILE_TEXTAREA}`, scroll: `${cardSelector} ${FILE_TEXTAREA}` };
  throw new Error(`No shown File editor (${mode ?? 'missing'})`);
}

// Read-only and serializable: runs in browser chrome from its source text, so
// it must not reference module scope. Returns which editor is shown, its
// nodes, the textarea model value and the shown selection/focus.
export function readShownFileEditor(card) {
  const textarea = card?.querySelector?.('[data-testid="file-editor"]') || null;
  const host = card?.querySelector?.('[data-testid="file-code-editor"]') || null;
  const content = host && !host.hidden && textarea?.hidden !== false ? host.querySelector('.cm-content') : null;
  if (!content && !textarea) return null;
  const doc = (content || textarea).ownerDocument;
  if (!content) {
    return { mode: 'textarea', input: textarea, scroller: textarea, value: textarea.value, shownText: textarea.value,
      selectionStart: textarea.selectionStart, selectionEnd: textarea.selectionEnd, focused: doc?.activeElement === textarea };
  }
  // CodeMirror renders each line as a `.cm-line` block; DOM text has no
  // newlines between them, so offsets add one per preceding line.
  const lines = [...content.children].filter(node => node.classList?.contains('cm-line'));
  const lineText = line => line.textContent || '';
  const offset = (node, at) => {
    let total = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (node === content && at <= [...content.childNodes].indexOf(line)) return total;
      if (line === node || line.contains(node)) {
        const range = doc.createRange(); range.selectNodeContents(line); range.setEnd(node, at);
        return total + range.toString().length;
      }
      total += lineText(line).length + 1;
    }
    return Math.max(0, total - 1);
  };
  const selection = doc?.defaultView?.getSelection?.();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const inside = range && content.contains(range.startContainer) && content.contains(range.endContainer);
  return { mode: 'codemirror', input: content, scroller: host.querySelector('.cm-scroller') || content,
    value: textarea?.value ?? null, shownText: lines.map(lineText).join('\n'),
    selectionStart: inside ? offset(range.startContainer, range.startOffset) : null,
    selectionEnd: inside ? offset(range.endContainer, range.endOffset) : null,
    focused: doc?.activeElement === content };
}

// Like egdesk-qa-ui-flow's chrome(), with `readShownFileEditor` in scope.
export const chromeWithFileEditor = (harness, fn, arg = null) => harness.evaluateChrome(
  `async () => { const readShownFileEditor = ${readShownFileEditor.toString()}; return await (${fn.toString()})(${JSON.stringify(arg)}); }`);

// Waits (bounded) for the card's CodeMirror load to settle so the mode cannot
// flip between resolving and typing, then returns that card's shown editor.
export async function resolveShownFileEditor(harness, cardSelector, { loadTimeoutMs = 5000 } = {}) {
  const mode = await chromeWithFileEditor(harness, async ({ selector, loadTimeoutMs: limit }) => {
    const cards = [...document.querySelectorAll(selector)];
    if (cards.length !== 1) return { error: `expected one File Card, found ${cards.length}` };
    const card = cards[0], view = card._fileView || card.querySelector('[data-testid="file-view"]')?._fileView;
    let timer;
    try {
      await Promise.race([Promise.resolve(view?.codeEditorReady).catch(() => false),
        new Promise(resolve => { timer = setTimeout(resolve, limit); })]);
    } finally { clearTimeout(timer); }
    return { mode: readShownFileEditor(card)?.mode ?? null };
  }, { selector: cardSelector, loadTimeoutMs });
  if (mode?.error) throw new Error(`File editor target: ${mode.error}`);
  return fileEditorSelectors(cardSelector, mode?.mode);
}
