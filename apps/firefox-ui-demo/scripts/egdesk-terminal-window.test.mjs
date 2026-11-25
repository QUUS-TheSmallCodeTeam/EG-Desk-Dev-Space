// Terminal window: shared Desk Window bar, Korean name, close question and
// the one warm dark gray shared by the bar, the body and the frame page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';

const overlay = new URL('../overlay/', import.meta.url);
const read = path => readFileSync(new URL(path, overlay), 'utf8');
const terminalSource = read('resources/surface/EGDeskSurfaceTerminal.mjs');
const css = read('CSS/eg-desk-surface.uc.css');
const html = read('resources/terminal.html');
const initializer = read('resources/egdesk-terminal-init.js');
const surface = read('JS/eg-desk-surface.uc.js');

// The exact private helper, without a test-only module export.
const confirmSource = terminalSource.match(/^  function terminalCloseNeedsConfirm\(api\) \{[\s\S]*?^  \}/m)?.[0];
assert.ok(confirmSource, 'the close rule stays inside the Terminal factory');
const terminalCloseNeedsConfirm = compileFunction(`${confirmSource}\nreturn terminalCloseNeedsConfirm;`)();

test('only a running session asks before its window closes', () => {
  assert.equal(terminalCloseNeedsConfirm({ ptyId: 'pty-1', isConnected: () => true }), true);
  assert.equal(terminalCloseNeedsConfirm({ ptyId: 'pty-1', isConnected: () => false }), true,
    'a session that lost its connection may still be running');
  assert.equal(terminalCloseNeedsConfirm({ ptyId: null, isConnected: () => true }), true);
  assert.equal(terminalCloseNeedsConfirm({ ptyId: null, isConnected: () => false }), false, 'an ended session closes at once');
  assert.equal(terminalCloseNeedsConfirm({ ptyId: '', isConnected: () => false }), false);
  assert.equal(terminalCloseNeedsConfirm(null), false, 'a frame that never loaded has no session');
  assert.equal(terminalCloseNeedsConfirm(undefined), false);
  assert.equal(terminalCloseNeedsConfirm({ get ptyId() { throw new Error('dead frame'); } }), false);
});

// ---- A small DOM with capture and bubble, enough for the real adapter ----
function makeNode(tag, props = {}, ...children) {
  const node = {
    tag, children: [], parent: null, listeners: [], attributes: {}, dataset: { ...(props.data || {}) },
    className: props.class || '', style: { ...(props.style || {}) }, hidden: props.hidden === true, textContent: '',
    id: props.id || '', title: props.title || '', focused: 0,
    appendChild(child) { this.children.push(child); child.parent = this; return child; },
    insertBefore(child, before) {
      const at = this.children.indexOf(before);
      this.children.splice(at < 0 ? this.children.length : at, 0, child); child.parent = this; return child;
    },
    replaceChildren(...next) { this.children = next; for (const child of next) child.parent = this; },
    addEventListener(type, fn, capture = false) { this.listeners.push({ type, fn, capture: capture === true }); },
    removeEventListener(type, fn, capture = false) {
      this.listeners = this.listeners.filter(item => !(item.type === type && item.fn === fn && item.capture === (capture === true)));
    },
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return name in this.attributes ? this.attributes[name] : null; },
    matches(selector) {
      return selector.split(',').map(part => part.trim()).some(part => part.startsWith('.')
        ? this.className.split(' ').includes(part.slice(1)) : this.tag === part);
    },
    closest(selector) { for (let at = this; at; at = at.parent) if (at.matches(selector)) return at; return null; },
    contains(other) { for (let at = other; at; at = at.parent) if (at === this) return true; return false; },
    find(selector) {
      for (const child of this.children) {
        if (child.matches?.(selector)) return child;
        const inner = child.find?.(selector);
        if (inner) return inner;
      }
      return null;
    },
    querySelector(selector) { return this.find(selector); },
    focus() { this.focused += 1; },
    get isConnected() { for (let at = this; at; at = at.parent) if (at.isRoot) return true; return false; },
  };
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (!['class', 'style', 'data', 'hidden', 'id', 'title'].includes(key) && value != null && value !== false) node.attributes[key] = String(value);
  }
  for (const child of children) {
    if (typeof child === 'string') node.textContent += child;
    else if (child) node.appendChild(child);
  }
  return node;
}

function dispatch(target, type, init = {}) {
  const event = { type, target, ...init, stopped: false, defaultPrevented: false,
    stopPropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; } };
  const path = [];
  for (let at = target; at; at = at.parent) path.unshift(at);
  for (const node of path.slice(0, -1)) {
    for (const item of [...node.listeners]) if (item.type === type && item.capture) item.fn(event);
    if (event.stopped) return event;
  }
  for (const item of [...target.listeners]) if (item.type === type) item.fn(event);
  if (event.stopped) return event;
  for (const node of path.slice(0, -1).reverse()) {
    for (const item of [...node.listeners]) if (item.type === type && !item.capture) item.fn(event);
    if (event.stopped) return event;
  }
  return event;
}

async function terminalWindow({ api, options = {}, windowOverrides = {}, depOverrides = {} } = {}) {
  const { createTerminalZone } = await import(new URL('resources/surface/EGDeskSurfaceTerminal.mjs', overlay));
  const events = [], messages = new Map(), documentListeners = [];
  const host = makeNode('main'); host.isRoot = true;
  const state = { activeEntityId: null };
  let shellOptions = null, closeDot = null, shell = null;
  const names = [...terminalSource.match(/const \{([\s\S]*?)\} = deps;/)[1].matchAll(/\b[A-Za-z_]\w*\b/g)].map(match => match[0]);
  const deps = Object.fromEntries(names.map(name => [name, () => {}]));
  Object.assign(deps, {
    TAG: 'unit', el: makeNode, allocCardSeq: () => 7, raiseCardZ: () => 3, state, boardCloseRequests: new Set(),
    completeAgendaClose: () => { events.push('board-close'); },
    RunResult: {
      summarizeRunResult: () => { events.push('run-result'); return { outcome: 'passed', headline: '완료' }; },
      renderRunResultCard: () => makeNode('div'),
    },
    makeSourceRef: (kind, details) => ({ kind, ...details }),
    resolveCanvasCardPlacement: () => ({ x: 10, y: 20, width: 640, height: 400 }),
    setActiveEntity: card => { state.activeEntityId = card.id; },
    focusCanvasCard: card => { events.push('focus-card'); state.activeEntityId = card.id; },
    // The shared shell as a kind adapter sees it. Its close dot calls the
    // shell's own close directly, exactly like spawnDeskWindowShell.
    spawnDeskWindowShell: options => {
      shellOptions = options;
      const root = makeNode('div', { id: options.id, class: `egd-canvas-card egd-desk-window ${options.className}`, style: options.style });
      const cleanups = [];
      const requestClose = () => { events.push('window-closed'); for (const dispose of cleanups) dispose(); root.parent.children.splice(root.parent.children.indexOf(root), 1); root.parent = null; return true; };
      closeDot = makeNode('span', { class: 'egd-card-dot egd-card-dot-close', onclick: ev => { ev.stopPropagation(); requestClose(); } });
      const identity = makeNode('div', { class: 'egd-desk-window-identity' });
      const actions = makeNode('div', { class: 'egd-desk-window-actions' });
      const topbar = makeNode('div', { class: 'egd-card-topbar egd-desk-window-titlebar' }, closeDot, identity, actions);
      const header = makeNode('div', { class: `egd-card-header ${options.headerClassName}` }, topbar);
      const content = makeNode('div', { class: `egd-card-body ${options.bodyClassName}` });
      root.appendChild(header); root.appendChild(content); host.appendChild(root);
      shell = { root, slots: { header, topbar, identity, actions, content }, requestClose, registerCleanup: dispose => { cleanups.push(dispose); } };
      return shell;
    },
  });
  Object.assign(deps, depOverrides);
  const frameWindow = { terminalAPI: api ? { hostEventKey: '00000000-0000-4000-8000-000000000001', focus: () => events.push('terminal-focus'), kill: async () => { events.push('session-killed'); return { ok: true }; }, ...api } : undefined };
  const el = deps.el;
  deps.el = (tag, props, ...children) => {
    const node = el(tag, props, ...children);
    if (tag === 'iframe') { node.contentWindow = frameWindow; node.src = props.src; node.contentDocument = { documentURI: props.src }; }
    return node;
  };
  const globals = {
    document: { getElementById: () => host,
      addEventListener: (type, fn, capture) => documentListeners.push({ type, fn, capture }),
      removeEventListener: (type, fn) => { const at = documentListeners.findIndex(item => item.type === type && item.fn === fn); if (at >= 0) documentListeners.splice(at, 1); } },
    window: { addEventListener: (type, fn) => messages.set(type, fn), removeEventListener: type => messages.delete(type), ...windowOverrides },
    console: { warn() {} }, setTimeout: fn => { fn(); return 0; },
  };
  const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const restore = () => { for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]; } };
  let card, zone;
  try { zone = createTerminalZone(deps); card = zone.spawnTerminalCard(options); } catch (error) { restore(); throw error; }
  const frame = card.find('iframe');
  const hostEventKey = frameWindow.terminalAPI?.hostEventKey;
  const receiver = messages.get('message');
  const directMessage = (data, envelope = {}) => receiver({ source: frameWindow, origin: 'chrome://userchrome', ...envelope, data: { hostEventKey, ...data } });
  const message = (data, envelope = {}) => messages.get('message') && directMessage(data, envelope);
  return { card, zone, host, events, state, shell, shellOptions, closeDot, documentListeners, message, restore, frame, hostEventKey, directMessage, unload: () => messages.get('unload')?.(), boardCloseRequests: deps.boardCloseRequests,
    confirm: card.find('.egd-terminal-close-confirm'), cancel: card.find('.egd-terminal-close-confirm-cancel'),
    go: card.find('.egd-terminal-close-confirm-go') };
}

test('the Terminal window uses the shared Desk Window bar with a Korean name and its session state', async () => {
  const h = await terminalWindow({ api: { ptyId: null, isConnected: () => false } });
  try {
    assert.equal(h.shellOptions.kind, 'terminal');
    assert.equal(h.shellOptions.className, 'egd-terminal-card');
    assert.deepEqual([h.shellOptions.minWidth, h.shellOptions.minHeight], [400, 300], 'the old minimum size is kept');
    assert.deepEqual(h.shellOptions.style, { top: '20px', left: '10px', width: '640px', height: '400px', zIndex: '3' });
    const identity = h.shell.slots.identity;
    assert.deepEqual(identity.children.map(child => child.className), ['egd-terminal-title', 'egd-terminal-session']);
    assert.equal(identity.children[0].textContent, '터미널');
    assert.equal(identity.children[1].textContent, '연결 중');
    assert.equal(identity.children[1].getAttribute('role'), 'status');
    assert.equal(h.shell.slots.actions.children[0].className, 'egd-terminal-run-chip', 'the result chip sits with the bar actions');
    assert.equal(h.closeDot.title, '터미널 닫기', 'the red dot opens the close choices');
    assert.equal(h.closeDot.getAttribute('aria-label'), '터미널 닫기');
    assert.deepEqual(h.card.children.map(child => child.className.split(' ').pop()),
      ['egd-terminal-header', 'egd-terminal-run-result', 'egd-terminal-close-confirm', 'egd-terminal-body']);
    h.message({ type: 'terminal-ready', shellLabel: 'zsh' });
    assert.equal(identity.children[0].textContent, '터미널', 'the shell name never replaces the window name');
    assert.equal(identity.children[1].textContent, 'zsh');
    h.message({ type: 'terminal-ready', shellLabel: 'x'.repeat(81) });
    assert.equal(identity.children[1].textContent, '실행 중');
    h.message({ type: 'terminal-exit-confirmed' });
    assert.equal(identity.children[1].textContent, '종료됨');
    h.message({ type: 'terminal-no-session' });
    assert.equal(identity.children[1].textContent, '세션 없음');
  } finally { h.restore(); }
  assert.doesNotMatch(terminalSource, /egd-terminal-title[^\n]+['"]Terminal['"]/, 'the actual window title is localized');
});

test('the red dot asks before closing a running session; 취소 keeps the window and the session', async () => {
  const h = await terminalWindow({ api: { ptyId: 'pty-9', isConnected: () => true } });
  try {
    assert.equal(h.confirm.hidden, true);
    assert.equal(h.confirm.getAttribute('role'), 'alertdialog');
    assert.equal(h.confirm.children[0].textContent, '터미널 세션도 함께 종료됩니다. 닫을까요?');
    assert.deepEqual([h.cancel.textContent, h.go.textContent], ['취소', '종료하고 닫기']);
    dispatch(h.closeDot, 'click');
    assert.equal(h.confirm.hidden, false, 'the question is shown');
    assert.deepEqual(h.events.filter(name => name === 'window-closed' || name === 'session-killed'), [], 'nothing closes or stops yet');
    assert.equal(h.cancel.focused, 1, 'the safe answer takes the keyboard');
    assert.equal(h.documentListeners.filter(item => item.type === 'mousedown').length, 1);
    dispatch(h.closeDot, 'click');
    assert.equal(h.documentListeners.filter(item => item.type === 'mousedown').length, 1, 'asking twice does not stack listeners');
    dispatch(h.cancel, 'click');
    assert.equal(h.confirm.hidden, true);
    assert.equal(h.host.children.includes(h.card), true, 'the window stays');
    assert.deepEqual(h.events.filter(name => name === 'window-closed' || name === 'session-killed'), []);
    assert.equal(h.events.includes('terminal-focus'), true, 'typing returns to the terminal');
    assert.equal(h.documentListeners.length, 0);
  } finally { h.restore(); }
});

test('종료하고 닫기 closes once and ends the session through the window cleanup', async () => {
  const h = await terminalWindow({ api: { ptyId: 'pty-9', isConnected: () => true } });
  try {
    dispatch(h.closeDot, 'click');
    dispatch(h.go, 'click');
    assert.deepEqual(h.events.filter(name => name === 'window-closed' || name === 'session-killed'), ['window-closed', 'session-killed']);
    assert.equal(h.host.children.includes(h.card), false);
    assert.equal(h.documentListeners.length, 0, 'no listener outlives the window');
  } finally { h.restore(); }
});

test('Esc, a press elsewhere, a press inside the terminal and a session that ends all withdraw the question', async () => {
  const h = await terminalWindow({ api: { ptyId: 'pty-9', isConnected: () => true } });
  try {
    dispatch(h.closeDot, 'click');
    const other = dispatch(h.cancel, 'keydown', { key: 'Enter' });
    assert.equal(other.stopped, false);
    assert.equal(h.confirm.hidden, false, 'other keys are left alone');
    const esc = dispatch(h.cancel, 'keydown', { key: 'Escape' });
    assert.equal(h.confirm.hidden, true);
    assert.equal(esc.stopped && esc.defaultPrevented, true, 'this Esc closes only the question');

    dispatch(h.closeDot, 'click');
    h.documentListeners[0].fn({ target: h.cancel });
    assert.equal(h.confirm.hidden, false, 'a press on the question itself keeps it');
    h.documentListeners[0].fn({ target: h.host });
    assert.equal(h.confirm.hidden, true);

    dispatch(h.closeDot, 'click');
    h.message({ type: 'terminal-activate' });
    assert.equal(h.confirm.hidden, true);

    dispatch(h.closeDot, 'click');
    h.message({ type: 'terminal-exit-confirmed' });
    assert.equal(h.confirm.hidden, true);
    assert.equal(h.events.includes('window-closed'), false, 'none of these closes the window');
  } finally { h.restore(); }
});

test('the close shortcut asks the same question, and a window without a running session closes at once', async () => {
  const running = await terminalWindow({ api: { ptyId: 'pty-9', isConnected: () => true } });
  try {
    assert.equal(running.shell.requestClose(), false, 'the shortcut path is the same gate');
    assert.equal(running.confirm.hidden, false);
    assert.equal(running.events.includes('window-closed'), false);
  } finally { running.restore(); }
  for (const api of [{ ptyId: null, isConnected: () => false }, null]) {
    const idle = await terminalWindow({ api });
    try {
      dispatch(idle.closeDot, 'click');
      assert.equal(idle.confirm.hidden, true);
      assert.equal(idle.events.filter(name => name === 'window-closed').length, 1, 'closed exactly once');
      assert.equal(idle.host.children.includes(idle.card), false);
    } finally { idle.restore(); }
  }
});

test('the shared shell gives the Terminal its kind icon, a working green dot and the shared fold dot', () => {
  const start = surface.indexOf('  function spawnDeskWindowShell(options = {}) {');
  const shellSource = surface.slice(start, surface.indexOf('\n  // ============ Canvas Shapes ============', start));
  assert.match(shellSource, /memo: 'note', terminal: 'terminal' \}\[kind\] \|\| 'square'/, 'the bar shows the terminal icon, not a square');
  // The green dot also opens a folded window first (the shared shell's fold).
  assert.match(shellSource, /class: 'egd-card-dot egd-card-dot-max egd-desk-window-control',[\s\S]*?title: '창 최대화',\s*'aria-label': '창 최대화',\s*'aria-pressed': 'false',\s*onclick: \(ev\) => \{\s*ev\.stopPropagation\(\);\s*if \(isCollapsed\(\)\) setCollapsed\(false\);\s*toggleCardFullscreen\(root\);\s*\},/);
  // UX-06: the Terminal folds through the shared shell; its yellow dot is no longer hidden.
  assert.doesNotMatch(css, /\.egd-terminal-card \.egd-card-dot-min \{ display: none; \}/, 'the Terminal shows the fold dot');
  assert.doesNotMatch(surface.slice(surface.indexOf('  function spawnDeskWindowShell('), surface.indexOf('  function spawnDeskWindowShell(') + 200), /collapsible: false/);
  assert.doesNotMatch(terminalSource, /egd-card-dot-(?:min|max)/, 'the Terminal no longer draws its own dots');
});

test('the bar, the body and the frame page use one warm dark gray from the same tokens', () => {
  const rule = selector => css.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([\\s\\S]*?)^\\}`, 'm'))?.[1] || '';
  const card = rule('.egd-terminal-card');
  const tokens = Object.fromEntries([...card.matchAll(/--egd-terminal-([a-z-]+): (#[0-9A-F]{6});/g)].map(match => [match[1], match[2]]));
  assert.deepEqual(tokens, { bg: '#262925', ink: '#EDECE7', muted: '#B5B9AE', line: '#41463F',
    control: '#363934', 'control-line': '#4A4E47', hover: '#414840' }, 'the approved dark pair, in both themes');
  for (const selector of ['.egd-terminal-card', '.egd-terminal-card .egd-card-header.egd-terminal-header', '.egd-terminal-body', '.egd-terminal-body browser,\n.egd-terminal-body iframe']) {
    assert.match(rule(selector), /background: var\(--egd-terminal-bg\);/, `${selector} shares the one background`);
  }
  assert.match(rule('.egd-terminal-body'), /border-top: 0;/, 'no light hairline between the bar and the body');
  assert.match(rule('.egd-terminal-card .egd-card-topbar'), /background: transparent;/);
  // Shared title-row parts take the dark pair through the ordinary tokens, on
  // the row only: the Board suggestion chip under it keeps the Desk's tokens.
  assert.match(rule('.egd-terminal-card .egd-card-topbar'),
    /--egd-on-surface: var\(--egd-terminal-ink\);\n  --egd-on-surface-variant: var\(--egd-terminal-muted\);\n  --egd-hover: var\(--egd-terminal-hover\);/);
  assert.doesNotMatch(rule('.egd-terminal-card .egd-card-header.egd-terminal-header'), /--egd-on-surface/);
  const terminalCss = css.slice(css.indexOf('/* ============ Terminal Card'), css.indexOf('/* ============ Ontology Map Card'));
  assert.deepEqual([...new Set(terminalCss.match(/#[0-9A-Fa-f]{3,8}\b/g))].sort(), Object.values(tokens).sort(),
    'the only literal colours in the Terminal rules are its token values');
  for (const stale of ['#27313A', '#151923', '#1a1a2e', '#B9C3CC', '#303348', '#24273b', '#454963', '#c9ccd8', '#c0c3d0']) {
    for (const [name, text] of [['css', css], ['terminal.html', html], ['init', initializer], ['adapter', terminalSource]]) {
      assert.equal(text.toLowerCase().includes(stale.toLowerCase()), false, `${stale} is gone from ${name}`);
    }
  }
  // The frame page cannot inherit the Desk stylesheet: its fallbacks equal the
  // host tokens, and the initializer copies the host's values over them.
  const pageTokens = Object.fromEntries([...html.matchAll(/--egd-terminal-([a-z-]+): (#[0-9A-F]{6});/g)].map(match => [match[1], match[2]]));
  const { hover: _hover, ...frameTokens } = tokens;
  assert.deepEqual(pageTokens, frameTokens);
  assert.match(html, /html, body \{[^}]*background: var\(--egd-terminal-bg\);/);
  assert.match(initializer, /const TERMINAL_TOKENS = \['bg', 'ink', 'muted', 'line', 'control', 'control-line'\];/);
  assert.match(initializer, /window\.parent\.getComputedStyle\(frame\)/);
  assert.match(initializer, /background: hostTokens\.bg \|\| '#262925',\n\s*foreground: hostTokens\.ink \|\| '#EDECE7',/);
  assert.match(initializer, /red: '#ff5555',/, 'the ANSI palette is left as it was');
});

test('the frame page takes the host window colours when it is framed and keeps its own when opened alone', () => {
  const block = initializer.slice(initializer.indexOf('  const TERMINAL_TOKENS ='), initializer.indexOf('  // ---- xterm.js setup ----'));
  const run = (window, document) => compileFunction(`${block}\nreturn hostTokens;`, ['window', 'document'])(window, document);
  const applied = [];
  const document = { documentElement: { style: { setProperty: (name, value) => applied.push([name, value]) } } };
  const values = { '--egd-terminal-bg': ' #101010 ', '--egd-terminal-ink': '#FAFAFA', '--egd-terminal-muted': '' };
  const framed = run({ frameElement: {}, parent: { getComputedStyle: () => ({ getPropertyValue: name => values[name] || '' }) } }, document);
  assert.deepEqual({ ...framed }, { bg: '#101010', ink: '#FAFAFA' });
  assert.deepEqual(applied, [['--egd-terminal-bg', '#101010'], ['--egd-terminal-ink', '#FAFAFA']]);
  assert.deepEqual({ ...run({ frameElement: null, parent: {} }, document) }, {}, 'opened alone: the page fallbacks stand');
  assert.deepEqual({ ...run({ get frameElement() { throw new Error('cross-origin'); } }, document) }, {}, 'an unreadable host never breaks the terminal');
});

test('a lost connection is told to the window, and the bar says so until the session is back', async () => {
  const body = initializer.match(/^  function showDisconnected\(message\) \{([\s\S]*?)^  \}/m)?.[1];
  assert.ok(body, 'exercise the production frame-page boundary');
  const show = compileFunction(body, ['message', 'closeRequested', 'renderCloseState', 'statusEl', 'connectBridge', 'notifyTerminalHost']);
  const posted = [], closeStates = [];
  const statusEl = { textContent: '', style: {}, classList: { remove() {} } };
  const notify = value => posted.push(value);
  show('연결이 끊겼습니다.', false, state => closeStates.push(state), statusEl, () => {}, notify);
  assert.deepEqual(posted, [{ type: 'terminal-disconnected' }]);
  assert.equal(statusEl.textContent, '연결이 끊겼습니다.');
  show('연결이 끊겼습니다.', true, state => closeStates.push(state), statusEl, () => {}, notify);
  assert.equal(posted.length, 1, 'a window that is already closing reports its close state instead');
  assert.equal(closeStates.length, 1);
  show('연결이 끊겼습니다.', false, () => {}, statusEl, () => {}, () => { throw new Error('gone'); });

  const h = await terminalWindow({ api: { ptyId: 'pty-9', isConnected: () => true } });
  try {
    const session = h.shell.slots.identity.children[1];
    h.message({ type: 'terminal-disconnected' });
    assert.equal(session.textContent, '연결 실패', 'a session that never came up failed to connect');
    h.message({ type: 'terminal-connecting' });
    assert.equal(session.textContent, '연결 중', 'pressing to reconnect says connecting again');
    h.message({ type: 'terminal-ready', shellLabel: 'zsh' });
    h.message({ type: 'terminal-disconnected' });
    assert.equal(session.textContent, '연결 끊김');
    h.message({ type: 'terminal-ready', shellLabel: 'zsh' });
    assert.equal(session.textContent, 'zsh');
  } finally { h.restore(); }
});

test('deleting a selected window goes through that window\'s own close gate', () => {
  const body = surface.match(/^  function deleteSelectedEntities\(\) \{([\s\S]*?)^  \}/m)?.[1];
  assert.ok(body, 'exercise the production delete path');
  const calls = [];
  const classes = (...names) => ({ contains: name => names.includes(name) });
  const terminal = { id: 'terminal', classList: classes('egd-canvas-card'), _deskWindowShell: { requestClose: () => { calls.push('gate:terminal'); return false; } } };
  const chat = { id: 'chat', classList: classes('egd-canvas-card') };
  const shape = { id: 'shape', classList: classes('egd-canvas-shape'), _cleanup: () => calls.push('cleanup:shape'), remove: () => calls.push('remove:shape') };
  compileFunction(body, ['document', 'closeCanvasCard', 'markAgendaDirty', 'setActiveEntity'])(
    { querySelectorAll: selector => { assert.equal(selector, '.egd-entity-selected'); return [terminal, chat, shape]; } },
    card => calls.push(`close:${card.id}`), (reason, entity) => calls.push(`${reason}:${entity.id}`), value => calls.push(`active:${value}`));
  assert.deepEqual(calls, ['gate:terminal', 'close:chat', 'cleanup:shape', 'remove:shape', 'delete-shape:shape', 'active:null'],
    'a running Terminal is asked instead of being removed; windows without a gate and shapes behave as before');
});

test('a close that is refused names the kind of window that was kept', async () => {
  const body = surface.match(/^  function closeCanvasCard\(card, cleanup\) \{([\s\S]*?)^  \}/m)?.[1];
  assert.ok(body, 'exercise the production close path');
  const notices = [];
  const close = compileFunction(body, ['card', 'cleanup', 'closeCanvasCard', 'boardNotice']);
  const refuse = kind => close({ dataset: kind ? { deskWindowKind: kind } : {}, _beforeClose: async () => { throw new Error('사유'); }, remove: () => assert.fail('the window stays') },
    undefined, () => assert.fail('not approved'), text => notices.push(text));
  assert.deepEqual([await refuse('terminal'), await refuse('file'), await refuse('memo'), await refuse(null), await refuse('toString')],
    [false, false, false, false, false]);
  assert.deepEqual(notices, ['터미널 창을 유지했습니다: 사유', '파일 창을 유지했습니다: 사유', '메모 창을 유지했습니다: 사유',
    '창을 유지했습니다: 사유', '창을 유지했습니다: 사유']);
});


test('privileged null-source events update the header before load and follow the current document key after reload', async () => {
  const h = await terminalWindow({ api: { ptyId: null, isConnected: () => false } });
  try {
    const status = h.shell.slots.identity.children[1];
    const deliver = data => h.message(data, { source: null });
    deliver({ type: 'terminal-api-ready' });
    deliver({ type: 'terminal-connecting' });
    deliver({ type: 'terminal-disconnected' });
    assert.equal(status.textContent, '연결 실패', 'no load handshake is needed for the first failure');
    deliver({ type: 'terminal-connecting' });
    assert.equal(status.textContent, '연결 중');
    deliver({ type: 'terminal-ready', shellLabel: 'zsh' });
    assert.equal(status.textContent, 'zsh');
    deliver({ type: 'terminal-disconnected' });
    assert.equal(status.textContent, '연결 끊김');
    // WindowProxy and URL stay the same; the loaded document/API do not.
    const newKey = '00000000-0000-4000-8000-000000000002';
    h.frame.contentDocument = { documentURI: h.frame.src };
    h.frame.contentWindow.terminalAPI = { hostEventKey: newKey };
    deliver({ type: 'terminal-ready', shellLabel: 'old document' });
    assert.equal(status.textContent, '연결 끊김', 'a queued old-document event cannot authenticate after reload');
    deliver({ type: 'terminal-api-ready', hostEventKey: newKey });
    deliver({ type: 'terminal-disconnected', hostEventKey: newKey });
    assert.equal(status.textContent, '연결 실패', 'the new document starts a new connection lifecycle');
  } finally { h.restore(); }
});

test('unauthenticated terminal messages cannot change UI, spawn a card, expose a result, dismiss a question or close a Board', async () => {
  const h = await terminalWindow({ api: { ptyId: 'pty-9', isConnected: () => true } });
  try {
    const status = h.shell.slots.identity.children[1];
    h.message({ type: 'terminal-ready', shellLabel: 'zsh' });
    assert.equal(status.textContent, 'zsh', 'a trusted ready event names the shell before the forged events arrive');
    h.card.dataset.projectionId = 'board-qa'; h.boardCloseRequests.add('board-qa');
    dispatch(h.closeDot, 'click'); h.state.activeEntityId = 'another-card';
    const before = [...h.events];
    const payloads = [
      { type: 'terminal-ready', shellLabel: 'forged' }, { type: 'terminal-api-ready' },
      { type: 'terminal-connecting' }, { type: 'terminal-disconnected' }, { type: 'terminal-exit-confirmed' }, { type: 'terminal-no-session' },
      { type: 'terminal-activate' }, { type: 'terminal-new-session', shellId: 'cmd' },
      { type: 'terminal-run-result', runResult: { output: 'forged result' } },
    ];
    const unchanged = () => {
      assert.deepEqual(h.events, before); assert.equal(h.host.children.length, 1);
      assert.equal(h.state.activeEntityId, 'another-card'); assert.equal(h.confirm.hidden, false);
      assert.equal(status.textContent, 'zsh'); assert.equal(h.card.find('.egd-terminal-run-result').hidden, true);
    };
    for (const envelope of [{ source: {} }, { source: undefined },
      ...['null', 'https://example.invalid', 'chrome://browser', 'chrome://userchrome.evil'].map(origin => ({ source: null, origin }))]) {
      for (const payload of payloads) h.message(payload, envelope);
      unchanged();
    }
    for (const hostEventKey of [undefined, null, '', 'other-card-key']) {
      for (const payload of payloads) h.message({ ...payload, hostEventKey }, { source: null });
      unchanged();
    }
    const current = h.frame.contentDocument;
    for (const replacement of [null, { documentURI: 'https://example.invalid/' },
      { documentURI: 'chrome://userchrome/content/other.html' }, { documentURI: h.frame.src + '?other=1' }]) {
      h.frame.contentDocument = replacement;
      for (const source of [null, h.frame.contentWindow]) for (const payload of payloads) h.message(payload, { source });
      unchanged();
    }
    Object.defineProperty(h.frame, 'contentDocument', { configurable: true, get() { throw new Error('dead frame'); } });
    for (const payload of payloads) h.message(payload, { source: null }); unchanged();
    Object.defineProperty(h.frame, 'contentDocument', { configurable: true, writable: true, value: current });
    const parent = h.frame.parent; h.frame.parent = null;
    for (const payload of payloads) h.message(payload, { source: null }); unchanged();
    h.frame.parent = parent;
    const api = h.frame.contentWindow.terminalAPI; delete h.frame.contentWindow.terminalAPI;
    for (const payload of payloads) h.message(payload, { source: null }); unchanged();
    h.frame.contentWindow.terminalAPI = api;
  } finally { h.restore(); }
});

test('cleanup revokes a captured terminal receiver even before a queued event can run', async () => {
  const h = await terminalWindow({ api: { ptyId: null, isConnected: () => false } });
  try {
    h.shell.requestClose(); const before = [...h.events];
    h.directMessage({ type: 'terminal-new-session', shellId: 'cmd' }, { source: null });
    h.directMessage({ type: 'terminal-ready', shellLabel: 'stale' }, { source: null });
    assert.deepEqual(h.events, before); assert.equal(h.host.children.length, 0);
  } finally { h.restore(); }
});

test('owned close keeps cancel, and detach closes only after a hold ACK without kill', async () => {
  let acknowledge, calls = 0;
  const ref = { ok: true, sessionId: 'live-pty', bridgeInstance: 'bridge', expiresAt: 12345, shellLabel: 'zsh' };
  const h = await terminalWindow({ api: { ptyId: 'live-pty', isConnected: () => true, canDetach: () => true,
    detachLocal: () => { calls++; return new Promise(resolve => { acknowledge = resolve; }); } } });
  try {
    const detach = h.confirm.children[3];
    dispatch(h.closeDot, 'click');
    assert.equal(detach.hidden, false);
    assert.equal(detach.textContent, '창만 닫고 실행 유지');
    dispatch(h.cancel, 'click');
    assert.equal(calls, 0);
    dispatch(h.closeDot, 'click');
    dispatch(detach, 'click');
    assert.equal(calls, 1);
    assert.equal(h.host.children.includes(h.card), true);
    acknowledge(ref); await Promise.resolve(); await Promise.resolve();
    assert.equal(h.host.children.includes(h.card), false);
    assert.equal(h.events.includes('session-killed'), false);
    const picker = h.zone.spawnTerminalCard({ idle: true });
    const held = picker.children.find(x => x.getAttribute('aria-label') === '유지 중인 Terminal');
    assert.equal(held.children[2].children[0].textContent, 'zsh 1 · 다시 연결');
    assert.match(surface, /cardState.type === 'terminal'\) \{[^}]+spawnTerminalCard\(\{ idle: true \}\)/);
  } finally { h.restore(); }
});

test('explicit terminate does not close the view at the request ACK', async () => {
  let confirmExit, attempts = 0;
  const h = await terminalWindow({ api: { ptyId: 'live-pty', closeForBoard: () => {
    attempts++; return new Promise(resolve => { confirmExit = resolve; });
  } } });
  try {
    dispatch(h.closeDot, 'click');
    assert.equal(h.confirm.children[3].hidden, true);
    dispatch(h.go, 'click');
    assert.equal(attempts, 1);
    confirmExit(false); await Promise.resolve();
    assert.equal(h.host.children.includes(h.card), true);
    assert.match(h.confirm.children[0].textContent, /종료를 확인하지 못했습니다/);
    dispatch(h.go, 'click');
    confirmExit(true); await Promise.resolve();
    assert.equal(h.host.children.includes(h.card), false);
    assert.equal(h.events.includes('session-killed'), false);
  } finally { h.restore(); }
});


test('Terminal ownership begins only at authenticated API readiness, and never reopens after unload', async () => {
  for (const idle of [true, false]) {
    const configured = [], requests = [];
    let identities = 0;
    const configureLocal = (transport, idle) => configured.push({ transport, idle });
    const h = await terminalWindow({ options: { idle }, api: { configureLocal }, windowOverrides: {
      crypto: { randomUUID: () => 'id-' + (++identities) },
      fetch: async (url, init) => { requests.push({ url, init }); return {}; },
    } });
    const ready = { type: 'terminal-api-ready' };
    try {
      assert.equal(new URL(h.frame.src).searchParams.get('managed'), '1');
      assert.equal(identities, 0, 'import, factory, window and iframe assembly allocate no owner');
      h.message(ready, { source: {} });
      h.message({ ...ready, hostEventKey: 'different-document' });
      assert.equal(identities, 0);
      assert.deepEqual(configured, []);
      h.message(ready, { source: null });
      assert.equal(identities, 2, 'one owner and one view id for the current frame');
      assert.deepEqual(configured.map(entry => entry.idle), [idle]);
      assert.deepEqual(requests, [], 'parent does not start a PTY on ready');
      const url = 'http://127.0.0.1:39218/terminal/shells';
      await configured[0].transport(url, { method: 'GET' });
      assert.deepEqual(requests[0].init.headers, { 'X-EGDesk-Terminal-Owner': 'id-1', 'X-EGDesk-Terminal-View': 'id-2' });
      h.frame.contentWindow.terminalAPI = { hostEventKey: 'reload', configureLocal };
      h.message(ready, { source: null });
      assert.equal(identities, 2, 'prior document cannot rotate ownership');
      h.message({ ...ready, hostEventKey: 'reload' }, { source: null });
      await configured[1].transport(url);
      assert.deepEqual(requests[1].init.headers, { 'X-EGDesk-Terminal-Owner': 'id-1', 'X-EGDesk-Terminal-View': 'id-3' });
      h.unload();
      assert.match(requests.at(-1).url, /close-local-scope$/);
      h.message({ ...ready, hostEventKey: 'reload' });
      assert.equal(identities, 3, 'no post-close ownership or view allocation');
      assert.equal(configured.length, 2);
    } finally { h.restore(); }
  }
});

// Exercise the managed iframe's real parent transport, not an unrestricted
// test fetch. File checks use this route before preparing and dispatching PTY input.
test('managed Terminal can verify the exact bound File project without widening File transport', async () => {
  const requests = [];
  let transport, identity = 0;
  const h = await terminalWindow({ options: { activate: false, reveal: false },
    api: { configureLocal(fn) { transport = fn; } }, windowOverrides: {
      crypto: { randomUUID: () => 'id-' + (++identity) },
      fetch: async (url, init) => { requests.push({url, init}); return {ok: true}; },
    } });
  const origin = 'http://127.0.0.1:39218';
  const url = origin + '/v1/files/projects/open';
  const request = { method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({boardId:'board-a', expectedProjectId:'project-a', expectedRootId:'root-a'}), signal: new AbortController().signal };
  try {
    h.message({type:'terminal-api-ready'}, {source:null});
    assert.equal(requests.length, 0, 'parent queues no action on connect');
    for (const [target, init] of [[url, {...request, method:'GET'}], [url, undefined],
      [url + '?extra=1', request], [url + '/', request], [url + '#extra', request],
      [origin + '/v1/files/projects/scripts', request], [origin + '/v1/files/projects/attach', request],
      [origin + '/v1/files/save', request], ['http://localhost:39218/v1/files/projects/open', request],
      ['http://127.0.0.1:39219/v1/files/projects/open', request], ['https://untrusted.test/v1/files/projects/open', request]]) {
      assert.throws(() => transport(target, init), /Invalid terminal transport/);
    }
    assert.equal(requests.length, 0);
    for (let phase = 0; phase < 2; phase++) await transport(url, request);
    assert.deepEqual(requests, Array.from({length:2}, () => ({url, init:{...request, redirect:'error',
      headers:{...request.headers, 'X-EGDesk-Terminal-Owner':'id-1', 'X-EGDesk-Terminal-View':'id-2'}}})));
    h.unload();
    assert.match(requests.at(-1).url, /\/terminal\/close-local-scope$/);
    assert.throws(() => transport(url, request), /Invalid terminal transport/);
    assert.equal(requests.length, 3);
  } finally { h.restore(); }
});

// L1 c34 (bridge flag EGDESK_TERMINAL_OPEN_URL): addresses a program of this session asked to open come to the card as 'terminal-open-url'; each opens a Browser Card beside it, in the background.
test('a terminal-open-url message opens a Browser Card for each http(s) address, in the background, beside this terminal; only the card\'s own authenticated frame can ask', async () => {
  const opened = [];
  const h = await terminalWindow({ api: { ptyId: 'pty-1', isConnected: () => true }, depOverrides: { spawnBrowserCard: (url, options) => { opened.push([url, options]); return {}; } } });
  try {
    const SIGN_IN = 'https://claude.com/cai/oauth/authorize?code=true&state=synthetic';
    h.message({ type: 'terminal-open-url', sessionId: 'pty-1', urls: [SIGN_IN] });
    assert.deepEqual(opened.map(([url]) => url), [SIGN_IN]);
    assert.equal(opened[0][1].background, true, 'no camera move, no activation: the person is typing in the terminal');
    assert.equal(opened[0][1].opener, h.card, 'placed with the terminal card as the opener');
    assert.equal(opened[0][1].openMode, 'new');
    h.message({ type: 'terminal-open-url', urls: [SIGN_IN] });
    assert.equal(opened.length, 1, 'the same address twice within seconds opens one card');
    h.message({ type: 'terminal-open-url', urls: ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://browser/content', 'https://user:pw@a.example/', 'not a url', 5, null] });
    h.message({ type: 'terminal-open-url', urls: 'https://a.example/' }); h.message({ type: 'terminal-open-url' });
    assert.equal(opened.length, 1, 'anything but a plain http(s) address is ignored');
    h.message({ type: 'terminal-open-url', urls: ['https://a.example/1', 'https://a.example/2', 'https://a.example/3', 'https://a.example/4', 'https://a.example/5', 'https://a.example/6'] });
    assert.equal(opened.length, 1 + 4, 'at most four addresses per message');
    const before = opened.length;
    for (const envelope of [{ source: {} }, { source: undefined }, { source: null, origin: 'https://example.invalid' }, { source: null, origin: 'chrome://userchrome.evil' }]) h.message({ type: 'terminal-open-url', urls: ['https://forged.example/'] }, envelope);
    for (const hostEventKey of [undefined, null, '', 'other-card-key']) h.message({ type: 'terminal-open-url', urls: ['https://forged.example/'], hostEventKey }, { source: null });
    assert.equal(opened.length, before, 'a forged message opens nothing');
  } finally { h.restore(); }
});

test('a Browser Card that cannot be opened is logged and the terminal keeps working', async () => {
  const h = await terminalWindow({ api: { ptyId: 'pty-1', isConnected: () => true }, depOverrides: { spawnBrowserCard: () => { throw new Error('card limit'); } } });
  try { h.message({ type: 'terminal-open-url', urls: ['https://a.example/'] }); h.message({ type: 'terminal-ready', shellLabel: 'zsh' }); assert.equal(h.shell.slots.identity.children[1].textContent, 'zsh'); } finally { h.restore(); }
});

test('the surface hands the Terminal zone spawnBrowserCard, and the frame page forwards openUrls of a read to its host', () => {
  assert.match(surface, /singletonSourceRef,\n\s+spawnBrowserCard,\n\s+spawnDeskWindowShell,/);
  assert.match(initializer, /Array\.isArray\(result\.openUrls\)[\s\S]{0,200}type: 'terminal-open-url'/);
});
