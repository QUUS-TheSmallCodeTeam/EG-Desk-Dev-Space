// CODE-04: the File view's code editor. CodeMirror 6 (vendored MIT bundle,
// see vendor/VENDOR.md) when it loads; the original <textarea> otherwise.
//
// The textarea stays the File view's text model: every CodeMirror edit is
// mirrored into textarea.value, so the existing dirty check, draft flush,
// save-to-original and SOURCE_CHANGED compare read one value in both modes.
// D-X5 (editor choice) is undecided; CodeMirror 6 is the inferred default.
//
// CodeMirror needs window globals (document, requestAnimationFrame), so the
// bundle is loaded into the File view's window, never into this shared module
// global. Without a window ChromeUtils (Node tests, failed load) the textarea
// remains the editor.

export const EGDESK_CODE_EDITOR_BUNDLE = 'vendor/codemirror/codemirror.bundle.mjs'

export function loadEGDeskCodeEditorBundle(document) {
  const chromeUtils = document?.defaultView?.ChromeUtils
  if (typeof chromeUtils?.importESModule !== 'function') return null
  const url = new URL(EGDESK_CODE_EDITOR_BUNDLE, import.meta.url).href
  try { return chromeUtils.importESModule(url, { global: 'current' }) } catch { return null }
}

const LANGUAGE_BY_EXTENSION = Object.freeze({
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json', jsonc: 'json', webmanifest: 'json',
  css: 'css',
  html: 'html', htm: 'html', xhtml: 'html',
  md: 'markdown', markdown: 'markdown',
  py: 'python', pyw: 'python', pyi: 'python',
})

// Syntax highlighting is chosen by the file name's last extension only.
export function codeLanguageForName(name) {
  const match = /\.([A-Za-z0-9]+)$/.exec(String(name || ''))
  return match ? LANGUAGE_BY_EXTENSION[match[1].toLowerCase()] || null : null
}

function languageExtension(bundle, language) {
  switch (language) {
    case 'javascript': return bundle.javascript()
    case 'jsx': return bundle.javascript({ jsx: true })
    case 'typescript': return bundle.javascript({ typescript: true })
    case 'tsx': return bundle.javascript({ typescript: true, jsx: true })
    case 'json': return bundle.json()
    case 'css': return bundle.css()
    case 'html': return bundle.html()
    case 'markdown': return bundle.markdown()
    case 'python': return bundle.python()
    default: return []
  }
}

// 1-based line → its character range in text. Lines past the end clamp to
// the last line (same rule as the earlier textarea jump).
export function lineRange(text, lineNumber) {
  const value = String(text ?? '')
  let start = 0
  let line = 1
  while (line < lineNumber) {
    const next = value.indexOf('\n', start)
    if (next < 0) break
    start = next + 1
    line++
  }
  const newline = value.indexOf('\n', start)
  return { line, start, end: newline < 0 ? value.length : newline }
}

// Korean UI text for CodeMirror's built-in panels (search, gutters).
export const EGDESK_CODE_EDITOR_PHRASES = Object.freeze({
  Find: '찾기', Replace: '바꾸기', next: '다음', previous: '이전', all: '모두',
  'match case': '대소문자 구분', regexp: '정규식', 'by word': '단어 단위', replace: '바꾸기', 'replace all': '모두 바꾸기',
  close: '닫기', 'current match': '현재 일치', 'on line': '행', 'replaced match on line $': '$행의 일치 항목을 바꿨습니다',
  'replaced $ matches': '일치 항목 $개를 바꿨습니다', 'Go to line': '줄로 이동', go: '이동',
  'Control character': '제어 문자', 'Folded lines': '접힌 줄', 'Unfolded lines': '펼친 줄', 'Fold line': '줄 접기', 'Unfold line': '줄 펼치기',
})

// Colors come only from --egd-* tokens, so the light and dark Desk themes
// (which swap the token values) both apply without a separate dark theme.
export const EGDESK_CODE_EDITOR_THEME = Object.freeze({
  '&': { height: '100%', color: 'var(--egd-on-surface)', backgroundColor: 'var(--egd-surface-elevated)', fontSize: '13px' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'ui-monospace, monospace', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--egd-on-surface)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--egd-on-surface)' },
  '.cm-selectionBackground, &.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, ::selection': { backgroundColor: 'var(--egd-card-selection)' },
  '.cm-activeLine': { backgroundColor: 'var(--egd-hover)' },
  '.cm-gutters': { color: 'var(--egd-on-surface-variant)', backgroundColor: 'var(--egd-surface)', borderRight: '1px solid var(--egd-outline-variant)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--egd-hover)', color: 'var(--egd-on-surface)' },
  '.cm-searchMatch': { backgroundColor: 'var(--egd-primary-container)', outline: '1px solid var(--egd-primary)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--egd-card-selection)' },
  '.cm-selectionMatch': { backgroundColor: 'var(--egd-primary-container)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': { backgroundColor: 'var(--egd-primary-container)', outline: '1px solid var(--egd-outline)' },
  '.cm-panels': { color: 'var(--egd-on-surface)', backgroundColor: 'var(--egd-surface)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--egd-outline-variant)' },
  '.cm-panel input[type=text], .cm-textfield': { color: 'var(--egd-on-surface)', backgroundColor: 'var(--egd-surface-elevated)', border: '1px solid var(--egd-outline)', borderRadius: '5px' },
  '.cm-foldPlaceholder': { color: 'var(--egd-on-surface-variant)', backgroundColor: 'var(--egd-surface)', border: '1px solid var(--egd-outline-variant)' },
})

const HIGHLIGHT = [
  [['keyword', 'operatorKeyword', 'controlKeyword', 'definitionKeyword', 'moduleKeyword'], { color: 'var(--egd-primary-strong)', fontWeight: '600' }],
  [['string', 'special(string)', 'regexp', 'attributeValue'], { color: 'var(--egd-success-ink)' }],
  [['comment', 'lineComment', 'blockComment', 'docComment'], { color: 'var(--egd-on-surface-variant)', fontStyle: 'italic' }],
  [['number', 'bool', 'null', 'atom'], { color: 'var(--egd-warning-ink)' }],
  [['function(variableName)', 'function(propertyName)', 'definition(function(variableName))'], { color: 'var(--egd-primary)' }],
  [['typeName', 'className', 'tagName', 'namespace'], { color: 'var(--egd-danger-ink)' }],
  [['propertyName', 'attributeName'], { color: 'var(--egd-secondary)' }],
  [['heading'], { color: 'var(--egd-primary-strong)', fontWeight: '700' }],
  [['emphasis'], { fontStyle: 'italic' }],
  [['strong'], { fontWeight: '700' }],
  [['link', 'url'], { color: 'var(--egd-primary)', textDecoration: 'underline' }],
  [['invalid'], { color: 'var(--egd-danger)' }],
]

// "function(variableName)" → tags.function(tags.variableName); unknown names
// are skipped so a different @lezer/highlight build cannot break the editor.
function resolveTag(tags, name) {
  const call = /^(\w+)\((.+)\)$/.exec(name)
  if (!call) return tags[name] || null
  const inner = resolveTag(tags, call[2])
  return inner && typeof tags[call[1]] === 'function' ? tags[call[1]](inner) : null
}

export function egdeskHighlightSpec(tags) {
  return HIGHLIGHT.map(([names, style]) => ({ tag: names.map(name => resolveTag(tags, name)).filter(Boolean), ...style }))
    .filter(rule => rule.tag.length)
}

// textarea: the File view's existing editor element (kept as the text model).
// host: an element to receive the CodeMirror view (placed next to textarea).
// loadBundle: () => bundle | Promise<bundle> | null.
export function createEGDeskCodeEditor({ textarea, host, label = '텍스트 작업사본', loadBundle, timers = globalThis }) {
  if (!textarea || !host) throw new Error('Code editor requires a textarea and a host element')
  const listeners = new Map()
  const on = (type, listener) => { listeners.set(type, [...(listeners.get(type) || []), listener]) }
  const emit = (type, detail) => { for (const listener of listeners.get(type) || []) listener(detail) }
  let bundle = null
  let view = null
  let language = null
  let readOnly = false
  let external = false
  let textareaComposing = false
  let mountPromise = null
  let destroyed = false
  let languageSlot = null
  let readOnlySlot = null
  host.hidden = true
  textarea.addEventListener?.('compositionstart', () => { textareaComposing = true })
  textarea.addEventListener?.('compositionend', () => { textareaComposing = false })

  function extensions() {
    const b = bundle
    return [
      b.lineNumbers(), b.highlightActiveLineGutter(), b.highlightSpecialChars(), b.history(), b.foldGutter(), b.drawSelection(),
      b.indentOnInput(), b.bracketMatching(), b.highlightActiveLine(), b.highlightSelectionMatches(), b.search({ top: true }),
      b.syntaxHighlighting(b.HighlightStyle.define(egdeskHighlightSpec(b.tags))), b.syntaxHighlighting(b.defaultHighlightStyle, { fallback: true }),
      // Tab is left to focus navigation (no indentWithTab keyboard trap).
      b.keymap.of([...b.defaultKeymap, ...b.historyKeymap, ...b.searchKeymap, ...b.foldKeymap]),
      b.EditorState.phrases.of(EGDESK_CODE_EDITOR_PHRASES),
      b.EditorView.theme(EGDESK_CODE_EDITOR_THEME),
      b.EditorView.contentAttributes.of({ 'aria-label': label, spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' }),
      languageSlot.of(languageExtension(b, language)),
      readOnlySlot.of(readOnlyExtension()),
      b.EditorView.domEventHandlers({
        compositionstart: () => { emit('compositionstart') },
        compositionend: () => { emit('compositionend') },
      }),
      b.EditorView.updateListener.of(update => {
        if (!update.docChanged || external) return
        textarea.value = update.state.doc.toString()
        emit('input')
      }),
    ]
  }
  const readOnlyExtension = () => [bundle.EditorState.readOnly.of(readOnly), bundle.EditorView.editable.of(!readOnly)]
  const freshState = text => bundle.EditorState.create({ doc: text, extensions: extensions() })

  function adopt(loaded) {
    if (destroyed || view) return !!view
    bundle = loaded
    languageSlot = new bundle.Compartment()
    readOnlySlot = new bundle.Compartment()
    const hadFocus = textarea.ownerDocument?.activeElement === textarea
    view = new bundle.EditorView({ state: freshState(textarea.value), parent: host })
    host.hidden = false
    textarea.hidden = true
    if (hadFocus) view.focus()
    return true
  }

  // Resolves true when CodeMirror is in place, false when the textarea stays.
  function mount() {
    if (mountPromise) return mountPromise
    mountPromise = (async () => {
      let loaded = null
      try { loaded = await (typeof loadBundle === 'function' ? loadBundle() : null) } catch { loaded = null }
      if (!loaded || typeof loaded.EditorView !== 'function' || typeof loaded.EditorState?.create !== 'function') return false
      // Never swap the element under an active IME composition.
      while (textareaComposing && !destroyed) await new Promise(resolve => timers.setTimeout(resolve, 50))
      try { return adopt(loaded) } catch {
        view = null; bundle = null; host.hidden = true; textarea.hidden = false
        host.replaceChildren?.()
        return false
      }
    })()
    return mountPromise
  }

  // Replace the whole text from outside (open file, restore). A new file
  // starts with a fresh undo history unless keepHistory is set.
  function setText(text, { keepHistory = false } = {}) {
    const value = String(text ?? '')
    textarea.value = value
    if (!view) return
    external = true
    try {
      if (keepHistory) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
      else view.setState(freshState(value))
    } finally { external = false }
  }

  function setLanguage(fileName) {
    language = codeLanguageForName(fileName)
    if (view) view.dispatch({ effects: languageSlot.reconfigure(languageExtension(bundle, language)) })
    return language
  }

  function setReadOnly(value) {
    readOnly = !!value
    textarea.readOnly = readOnly
    if (view) view.dispatch({ effects: readOnlySlot.reconfigure(readOnlyExtension()) })
  }

  // Select a 1-based line, scroll it into view and focus. Returns the line
  // actually reached (clamped) or 0 when the request is invalid.
  function revealLine(lineNumber) {
    if (!Number.isInteger(lineNumber) || lineNumber < 1) return 0
    if (view) {
      const doc = view.state.doc
      const line = doc.line(Math.min(lineNumber, doc.lines))
      view.dispatch({ selection: { anchor: line.from, head: line.to }, effects: bundle.EditorView.scrollIntoView(line.from, { y: 'center' }) })
      view.focus()
      return line.number
    }
    const range = lineRange(textarea.value, lineNumber)
    const lineHeight = Number.parseFloat(textarea.ownerDocument?.defaultView?.getComputedStyle?.(textarea)?.lineHeight) || 18
    textarea.scrollTop = Math.max(0, (range.line - 1) * lineHeight - (textarea.clientHeight || 0) / 3)
    textarea.focus()
    textarea.setSelectionRange?.(range.start, range.end)
    return range.line
  }

  const command = name => () => {
    if (!view || readOnly && name !== 'openSearchPanel') return false
    return !!bundle[name](view)
  }

  return {
    on,
    mount,
    setText,
    setLanguage,
    setReadOnly,
    revealLine,
    undo: command('undo'),
    redo: command('redo'),
    openSearch: command('openSearchPanel'),
    focus() { if (view) view.focus(); else textarea.focus() },
    get mode() { return view ? 'codemirror' : 'textarea' },
    get language() { return language },
    get readOnly() { return readOnly },
    get composing() { return view ? !!view.composing : textareaComposing },
    get scrollTop() { return view ? view.scrollDOM.scrollTop : textarea.scrollTop },
    set scrollTop(value) { if (view) view.scrollDOM.scrollTop = value; else textarea.scrollTop = value },
    destroy() { destroyed = true; view?.destroy(); view = null },
  }
}
