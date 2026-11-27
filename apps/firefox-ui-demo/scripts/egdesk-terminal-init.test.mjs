import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import { spawnSync } from 'node:child_process';
import { readSurfaceSource } from './egdesk-surface-source.mjs';
import * as TerminalState from '../overlay/resources/EGDeskTerminalState.sys.mjs';

const resources = new URL('../overlay/resources/', import.meta.url);
const initializer = readFileSync(new URL('egdesk-terminal-init.js', resources), 'utf8');
// Exercise the exact private helper without adding a test-only module export.
const terminalSurface = readFileSync(new URL('surface/EGDeskSurfaceTerminal.mjs', resources), 'utf8');
const wheelRouteSource = terminalSurface.match(/^  function routeTerminalFrameWheel\(state, card, frame, event\) \{[\s\S]*?^  \}/m)?.[0];
assert.ok(wheelRouteSource, 'the wheel helper stays inside the Terminal factory');
const routeTerminalFrameWheel = compileFunction(`${wheelRouteSource}\nreturn routeTerminalFrameWheel;`)();
const settle = async () => { for (let count = 0; count < 12; count++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

function actualXtermKeyboard({ guard = false } = {}) {
  const source = readFileSync(new URL('vendor/xterm.min.js', resources), 'utf8');
  const module = { exports: {} };
  compileFunction(source, ['module', 'exports'])(module, module.exports);
  const term = new module.exports.Terminal({ allowProposedApi: true });
  const core = term._core, sent = [];
  core.browser = { isMac: true, isWindows: false };
  core._compositionHelper = { keydown: () => true };
  core.textarea = { value: '' };
  core.updateCursorStyle = () => {};
  core._showCursor = () => {};
  core.focus = () => {};
  term.onData(data => sent.push(data));
  const keyGuard = guard ? TerminalState.createTerminalKeyEventGuard() : null;
  if (keyGuard) {
    term.attachCustomKeyEventHandler(event => keyGuard.keyEvent(event));
    term.onKey(event => keyGuard.onKey(event));
  }
  const event = (type, key, extra = {}) => ({ type, key, code: 'Key' + key.toUpperCase(),
    keyCode: key.toUpperCase().charCodeAt(0), which: key.charCodeAt(0),
    charCode: type === 'keypress' ? key.charCodeAt(0) : 0, location: 0,
    ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, isComposing: false,
    getModifierState: () => false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.propagationStopped = true; }, ...extra });
  const keydown = (key, extra) => { const e = event('keydown', key, extra); core._keyDown(e); return e; };
  const keypress = (key, extra) => { const e = event('keypress', key, extra); core._keyPress(e); return e; };
  const keyup = (key, extra) => { const e = event('keyup', key, extra); core._keyUp(e); return e; };
  const input = (data, extra = {}) => {
    const e = event('input', data, { data, inputType: 'insertText', composed: false, ...extra });
    keyGuard?.input(e);
    if (!e.propagationStopped) core._inputEvent(e);
    return e;
  };
  return { sent, term, keyGuard, keydown, keypress, keyup, input };
}

test('bundled xterm reproduces a delivered keydown plus keypress as llss; guard uses the physical key boundary', () => {
  for (const [guard, expected] of [[false, 'llss'], [true, 'ls']]) {
    const h = actualXtermKeyboard({ guard });
    for (const key of 'ls') {
      assert.equal(h.keydown(key).defaultPrevented, true);
      h.keypress(key); h.keyup(key);
    }
    assert.equal(h.sent.join(''), expected);
  }
  const repeated = actualXtermKeyboard({ guard: true });
  for (const key of 'll') { repeated.keydown(key); repeated.keypress(key); repeated.keyup(key); }
  assert.equal(repeated.sent.join(''), 'll', 'separate physical presses are not de-duplicated');
  const held = actualXtermKeyboard({ guard: true });
  for (let i = 0; i < 3; i++) { held.keydown('l', { repeat: i > 0 }); held.keypress('l'); }
  held.keyup('l');
  assert.equal(held.sent.join(''), 'lll', 'auto-repeat remains three keydown actions');
});

test('only the matching insertText input in the same physical key is stopped', () => {
  const h = actualXtermKeyboard({ guard: true });
  h.keydown('l');
  assert.equal(h.input('l').propagationStopped, true);
  h.keyup('l');
  assert.equal(h.input('l').propagationStopped, undefined, 'input without a matching physical key remains valid');
  assert.equal(h.sent.join(''), 'll');
  const ime = actualXtermKeyboard({ guard: true });
  ime.keydown('a');
  assert.equal(ime.input('a', { isComposing: true, inputType: 'insertCompositionText' }).propagationStopped, undefined);
  assert.equal(ime.input('a', { inputType: 'insertFromPaste' }).propagationStopped, undefined);
  ime.keyGuard.reset();
  assert.equal(ime.input('a').propagationStopped, undefined, 'composition or paste resets the key action');
});

test('terminal writes preserve text, backspace and paste order exactly once', async () => {
  const first = deferred(), calls = [];
  const queue = TerminalState.createTerminalWriteQueue({ write: async (id, data) => {
    calls.push([id, data]); if (calls.length === 1) await first.promise; return { ok: true };
  } });
  queue.bind('session-a');
  const pending = ['a', '\x7f', '한글 paste\n'].map(data => queue.enqueue(data));
  await settle();
  assert.deepEqual(calls, [['session-a', 'a']]);
  first.resolve();
  await Promise.all(pending);
  assert.deepEqual(calls, [['session-a', 'a'], ['session-a', '\x7f'], ['session-a', '한글 paste\n']]);
});

test('write failure is visible and fences queued text without automatic replay', async () => {
  const calls = [], errors = [], first = deferred();
  const queue = TerminalState.createTerminalWriteQueue({ write: async (id, data) => {
    calls.push([id, data]); if (data === 'first') await first.promise; return { ok: true };
  }, onError: (error, id) => errors.push([error.message, id]) });
  queue.bind('failed');
  const failed = queue.enqueue('first'), stale = queue.enqueue('must not replay');
  const rejected = assert.rejects(failed, /write unavailable/);
  await settle(); first.reject(new Error('write unavailable'));
  await rejected;
  assert.equal((await stale).skipped, true);
  assert.deepEqual(errors, [['write unavailable', 'failed']]);
  queue.bind('replacement');
  await queue.enqueue('explicit new input');
  assert.deepEqual(calls, [['failed', 'first'], ['replacement', 'explicit new input']]);
});

test('close and session replacement discard pending old-session input', async () => {
  const first = deferred(), calls = [];
  const queue = TerminalState.createTerminalWriteQueue({ write: async (id, data) => {
    calls.push([id, data]); if (calls.length === 1) await first.promise; return { ok: true };
  } });
  queue.bind('old');
  const running = queue.enqueue('already dispatched'), pending = queue.enqueue('queued old');
  await settle(); queue.invalidate(); queue.bind('new');
  const replacement = queue.enqueue('new text');
  first.resolve(); await running;
  assert.equal((await pending).skipped, true); await replacement;
  assert.deepEqual(calls, [['old', 'already dispatched'], ['new', 'new text']]);
});

function compositionFixture() {
  const sent = [], timers = new Map(), errors = [];
  let serial = 0, key = 1, cleanups = 0;
  const gate = TerminalState.createTerminalCompositionGate({
    send: data => { sent.push(data); return Promise.resolve({ ok: true }); },
    sessionKey: () => key, onFallback: () => cleanups++, onError: error => errors.push(error.message),
    schedule: fn => { timers.set(++serial, fn); return serial; }, cancel: id => timers.delete(id),
  });
  const tick = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
  return { gate, sent, tick, timers, errors, cleanups: () => cleanups, replace: () => key++ };
}

test('native IME commits before or after compositionend are never sent twice', async () => {
  for (const beforeEnd of [true, false]) {
    const h = compositionFixture();
    h.gate.start();
    if (beforeEnd) await h.gate.data('한글');
    h.gate.end('한글');
    if (!beforeEnd) await h.gate.data('한글');
    h.tick(); await settle();
    assert.deepEqual(h.sent, ['한글']);
    assert.equal(h.cleanups(), 0, 'native-owned textarea must not be cleared by a fallback');
  }
});

test('fragmented native composition remains native-owned without an extra whole-text commit', async () => {
  const h = compositionFixture();
  h.gate.start(); h.gate.end('한글');
  await h.gate.data('한'); h.tick(); await h.gate.data('글');
  assert.deepEqual(h.sent, ['한', '글']);
  assert.equal(h.cleanups(), 0);
});

test('missing native IME data uses one fallback and suppresses one late exact duplicate', async () => {
  const h = compositionFixture();
  h.gate.start(); h.gate.end('가'); h.tick();
  assert.deepEqual(h.sent, ['가']); assert.equal(h.cleanups(), 1);
  assert.equal((await h.gate.data('가')).suppressedDuplicate, true);
  h.gate.boundary();
  await h.gate.data('가');
  assert.deepEqual(h.sent, ['가', '가'], 'a later real key with equal text remains valid input');
});

test('fast repeated equal compositions, Enter and an equal paste retain input order', async () => {
  const repeated = compositionFixture();
  repeated.gate.start(); repeated.gate.end('가');
  repeated.gate.start(); repeated.gate.end('가'); repeated.tick();
  assert.deepEqual(repeated.sent, ['가', '가']);
  const enter = compositionFixture();
  enter.gate.start(); enter.gate.end('한글'); enter.gate.boundary(); await enter.gate.data('\r');
  assert.deepEqual(enter.sent, ['한글', '\r']);
  const paste = compositionFixture();
  paste.gate.start(); paste.gate.end('가'); paste.gate.boundary(); await paste.gate.data('가');
  assert.deepEqual(paste.sent, ['가', '가']);
});

test('closing or replacing a session cancels pending IME fallback without sending', () => {
  const closed = compositionFixture();
  closed.gate.start(); closed.gate.end('닫힘'); closed.gate.invalidate(); closed.tick();
  assert.deepEqual(closed.sent, []);
  const replaced = compositionFixture();
  replaced.gate.start(); replaced.gate.end('이전'); replaced.replace(); replaced.tick();
  assert.deepEqual(replaced.sent, []);
});

class Element {
  constructor(id = '') {
    this.id = id; this.children = []; this.listeners = new Map(); this.style = {};
    this.value = ''; this.textContent = ''; this.disabled = false;
    const values = new Set();
    this.classList = { add: name => values.add(name), remove: name => values.delete(name), contains: name => values.has(name) };
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) { this.children.push(child); return child; }
  removeChild(child) { this.children.splice(this.children.indexOf(child), 1); }
  setAttribute(key, value) { this[key] = value; }
  get dataset() { return this._data ||= {}; }
  addEventListener(type, fn, capture = false) {
    const list = this.listeners.get(type) || []; list.push({ fn, capture }); this.listeners.set(type, list);
  }
  dispatch(type, event = {}) { for (const listener of this.listeners.get(type) || []) listener.fn(event); }
  querySelector(selector) { return selector === '.xterm-helper-textarea' ? this.textarea : null; }
}

async function uiFixture({ search = '', platform = 'win32', transport = 'conpty', respond = null, timeouts = null, webLinks = null } = {}) {
  const ids = ['status-overlay', 'terminal-container', 'terminal-shell-select', 'terminal-shell-start', 'terminal-shell-label', 'terminal-operation-status'];
  const elements = Object.fromEntries(ids.map(id => [id, new Element(id)]));
  elements['terminal-shell-select'].disabled = true;
  elements['terminal-shell-start'].disabled = true;
  elements['terminal-operation-status'].classList.add('hidden');
  const requests = [], messages = [], frames = [], intervals = new Map(), windowListeners = new Map(), warnings = [];
  let intervalId = 0, term, observer;
  class FakeTerminal {
    constructor() { term = this; this.cols = 80; this.rows = 24; this.options = {}; this.focusCalls = 0; this.output = []; this.buffer = { active: { length: 0, getLine() {} } }; }
    open(container) { container.textarea = new Element('textarea'); }
    loadAddon() {}
    attachCustomKeyEventHandler(fn) { this.keyHandler = fn; }
    onKey(fn) { this.keyListener = fn; }
    onData(fn) { this.send = fn; }
    write(data, callback) { this.output.push(data); if (callback) { this.send('synthetic device reply'); callback(); } }
    focus() { this.focusCalls++; }
    paste(data) { this.send(data); }
  }
  const shellResponse = { ok: true, platform, transport, ptyRequired: platform === 'win32',
    defaultShellId: platform === 'win32' ? 'powershell' : 'default',
    shells: platform === 'win32'
      ? [{ id: 'powershell', label: 'PowerShell', available: true }, { id: 'cmd', label: 'CMD', available: true }]
      : [{ id: 'default', label: 'zsh', available: true }] };
  const defaults = (route, body) => {
    if (route === '/terminal/shells') return shellResponse;
    if (route === '/terminal/spawn') return { ok: true, sessionId: 'owned-pty', shellId: body.shellId,
      shellLabel: body.shellId === 'cmd' ? 'CMD' : platform === 'win32' ? 'PowerShell' : 'zsh',
      transport: platform === 'win32' ? 'conpty' : 'pty', usePty: true, degraded: false,
      windowsBuildNumber: platform === 'win32' ? 26200 : undefined };
    if (route === '/terminal/read') return { ok: true, sessionId: body.sessionId, status: 'RUNNING', data: '', exited: false, exitConfirmed: false };
    if (route === '/terminal/kill') return { ok: true, sessionId: body.sessionId, status: 'EXITED', exited: true, exitConfirmed: true,
      ...(platform === 'win32' ? { exitSource: 'conpty-worker.native-onExit', nativeExitConfirmed: true,
        workerCloseConfirmed: true, workerExitCode: 0, workerExitSignal: null } : {}) };
    return { ok: true, resized: true, cols: body.cols, rows: body.rows };
  };
  const fetch = async (url, options) => {
    const route = new URL(url).pathname, body = options.body ? JSON.parse(options.body) : null;
    requests.push({ route, body, method: options.method });
    const value = respond ? await respond(route, body, defaults, options) : defaults(route, body);
    const status = value.httpStatus || 200;
    return { ok: status >= 200 && status < 300, status, json: async () => value };
  };
  const hostEventKey = crypto.randomUUID();
  const window = { location: { search }, crypto: { randomUUID: () => hostEventKey }, parent: { postMessage: value => messages.push(value) },
    setTimeout: timeouts?.set || setTimeout, addEventListener: (type, fn) => windowListeners.set(type, fn) };
  const document = { getElementById: id => elements[id], createElement: () => new Element() };
  const source = initializer.replace("await import('chrome://userchrome/content/EGDeskTerminalState.sys.mjs')", 'TerminalState')
    .replace('(async () => {', 'return (async () => {');
  assert.notEqual(source, initializer);
  const run = compileFunction(source, ['TerminalState', 'Terminal', 'FitAddon', 'WebLinksAddon', 'document', 'window', 'fetch',
    'requestAnimationFrame', 'ResizeObserver', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'AbortController', 'URLSearchParams', 'console']);
  await run(TerminalState, FakeTerminal, { FitAddon: class { fit() {} } }, webLinks ? { WebLinksAddon: class { constructor(handler) { webLinks.handler = handler; } } } : undefined, document, window, fetch,
    fn => frames.push(fn), class { constructor(fn) { observer = this; this.callback = fn; } observe() {} disconnect() { this.disconnected = true; } },
    timeouts?.set || setTimeout, timeouts?.clear || clearTimeout, fn => { intervals.set(++intervalId, fn); return intervalId; }, id => intervals.delete(id),
    AbortController, URLSearchParams, { warn: (...args) => warnings.push(args) });
  const h = { elements, requests, messages, get term() { return term; }, window, intervals, warnings, observer, hostEventKey,
    api: window.terminalAPI, fetch, boot: async () => { await frames.shift()(); await settle(); },
    event: (type, event = {}) => windowListeners.get(type)?.(event) };
  return h;
}

test('shell selection opens a separate CMD Card without killing or switching PowerShell', async () => {
  const h = await uiFixture(); await h.boot();
  const spawn = h.requests.find(item => item.route === '/terminal/spawn');
  assert.equal(spawn.body.shellId, 'powershell'); assert.equal(spawn.body.shell, undefined);
  assert.equal(h.api.isConnected(), true);
  assert.deepEqual(h.term.options.windowsPty, { backend: 'conpty', buildNumber: 26200 });
  const before = h.requests.length;
  h.elements['terminal-shell-select'].value = 'cmd';
  h.elements['terminal-shell-select'].dispatch('change');
  assert.equal(h.requests.length, before);
  h.elements['terminal-shell-start'].dispatch('click');
  assert.deepEqual(h.messages.at(-1), { type: 'terminal-new-session', shellId: 'cmd', hostEventKey: h.hostEventKey });
  assert.equal(h.requests.filter(item => item.route === '/terminal/spawn').length, 1);
  assert.equal(h.requests.filter(item => item.route === '/terminal/kill').length, 0);
  assert.equal(h.api.sessionInfo().shellId, 'powershell');
  const cmd = await uiFixture({ search: '?shellId=cmd' }); await cmd.boot();
  assert.equal(cmd.requests.find(item => item.route === '/terminal/spawn').body.shellId, 'cmd');
});

test('POSIX uses the backend default and degraded pipe mode is labeled explicitly', async () => {
  const h = await uiFixture({ platform: 'darwin', transport: 'pty', respond: (route, body, defaults) =>
    route === '/terminal/spawn' ? { ...defaults(route, body), transport: 'pipe', usePty: false, degraded: true } : defaults(route, body) });
  await h.boot();
  assert.deepEqual(h.requests.find(item => item.route === '/terminal/spawn').body, { shellId: 'default', cols: 80, rows: 24 });
  assert.equal(h.api.isConnected(), true);
  assert.match(h.elements['terminal-operation-status'].textContent, /파이프/);
});

test('Windows never advertises a pipe receipt as a working ConPTY terminal', async () => {
  const h = await uiFixture({ respond: (route, body, defaults) => route === '/terminal/spawn'
    ? { ...defaults(route, body), transport: 'pipe', usePty: false, degraded: true } : defaults(route, body) });
  await h.boot();
  assert.equal(h.api.isConnected(), false);
  assert.match(h.elements['terminal-operation-status'].textContent, /ConPTY/);
  assert.equal(h.api.closeState().phase, 'confirmed');
  assert.equal(h.requests.filter(item => item.route === '/terminal/kill').length, 1);
  const unavailable = await uiFixture({ transport: 'unavailable' }); await unavailable.boot();
  assert.equal(unavailable.requests.some(item => item.route === '/terminal/spawn'), false);
});

test('input failure is visible; reconnect reuses the same PTY without replay', async () => {
  let failWrite = true;
  const h = await uiFixture({ respond: (route, body, defaults) => {
    if (route === '/terminal/write' && failWrite) return { ok: false, error: 'input unavailable', httpStatus: 503 };
    return defaults(route, body);
  } }); await h.boot();
  const failed = h.api.write('first'), stale = h.api.write('queued text');
  await assert.rejects(failed, /input unavailable/); assert.equal((await stale).skipped, true);
  assert.match(h.elements['status-overlay'].textContent, /자동으로 다시 보내지 않습니다/);
  // The raw transport error is not part of the Korean line; it sits folded under '자세히' once.
  assert.doesNotMatch(h.elements['status-overlay'].textContent, /input unavailable/);
  const rawDetails = h.elements['status-overlay'].children.filter(child => child.children[0]?.textContent === '자세히');
  assert.equal(rawDetails.length, 1); assert.equal(rawDetails[0].children[1].textContent, 'input unavailable');
  assert.equal(h.term.output.some(chunk => String(chunk).includes('input unavailable')), false);
  assert.equal(h.api.isConnected(), false);
  assert.equal(h.term.options.disableStdin, true);
  failWrite = false;
  h.elements['status-overlay'].onclick(); await settle(); await settle();
  assert.equal(h.api.isConnected(), true);
  assert.equal(h.term.options.disableStdin, false);
  await h.api.write('explicit new input');
  assert.equal(h.requests.filter(item => item.route === '/terminal/spawn').length, 1);
  assert.deepEqual(h.requests.filter(item => item.route === '/terminal/write').map(item => item.body.data), ['first', 'explicit new input']);
});

test('unsupported resize rejects and stays visible rather than reporting success', async () => {
  const h = await uiFixture({ respond: (route, body, defaults) => route === '/terminal/resize'
    ? { ok: false, code: 'RESIZE_UNSUPPORTED', error: 'PTY resizing unavailable', resized: false, httpStatus: 501 } : defaults(route, body) });
  await h.boot();
  await assert.rejects(h.api.resize(100, 30), /PTY resizing unavailable/);
  assert.equal(h.elements['terminal-operation-status'].classList.contains('hidden'), false);
  assert.match(h.elements['terminal-operation-status'].textContent, /크기 변경/);
  assert.equal(h.api.isConnected(), true);
});

test('initializer defers IME fallback and preserves API paste as the next input action', async () => {
  const h = await uiFixture(); await h.boot();
  const container = h.elements['terminal-container'];
  for (const name of ['compositionstart', 'keydown', 'paste']) assert.equal(container.listeners.get(name)[0].capture, true);
  assert.equal(container.listeners.get('compositionend')[0].capture, false);
  container.textarea.value = '한글';
  container.dispatch('compositionstart'); container.dispatch('compositionend', { data: '한글' });
  h.term.send('한글'); await settle();
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.deepEqual(h.requests.filter(item => item.route === '/terminal/write').map(item => item.body.data), ['한글']);
  assert.equal(container.textarea.value, '한글', 'native-owned textarea is not cleared');
  container.dispatch('compositionstart'); container.dispatch('compositionend', { data: '가' });
  h.api.paste('가'); await settle();
  assert.deepEqual(h.requests.filter(item => item.route === '/terminal/write').map(item => item.body.data), ['한글', '가', '가']);
});

test('actual typing activates the owning card without activating on programmatic focus or an untouched frame', async () => {
  const h = await uiFixture({ search: '?autofocus=0' }); await h.boot();
  const activations = () => h.messages.filter(message => message.type === 'terminal-activate').length;
  assert.equal(activations(), 0);
  h.api.focus(); assert.equal(activations(), 0);
  h.event('mousedown', { target: { closest: () => null } });
  h.elements['terminal-container'].dispatch('keydown', { key: 'l', isComposing: false, keyCode: 76 });
  h.elements['terminal-container'].dispatch('compositionstart');
  h.elements['terminal-container'].dispatch('paste');
  assert.equal(activations(), 4);
  const other = await uiFixture(); await other.boot();
  assert.equal(other.term.focusCalls, 0, 'embedded startup leaves focus to the currently active card');
});

test('frame wheel bridge stops handled canvas events and leaves active terminal wheel events native', async () => {
  const h = await uiFixture(); await h.boot();
  assert.equal(h.messages.some(message => message.type === 'terminal-api-ready'), true);
  const event = () => ({ preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } });
  let received;
  h.api.setWheelHandler(e => { received = e; return true; });
  const inactive = event(); h.event('wheel', inactive);
  assert.equal(received, inactive); assert.equal(inactive.prevented, true); assert.equal(inactive.stopped, true);
  h.api.setWheelHandler(() => false);
  const active = event(); h.event('wheel', active);
  assert.equal(active.prevented, undefined); assert.equal(active.stopped, undefined);
  assert.throws(() => h.api.setWheelHandler('invalid'), TypeError);
});

test('terminal frame routes inactive plain wheels to canvas and delegates gesture policy to Main when available', () => {
  const card = { id: 'terminal' }, frame = {}, panned = [];
  const state = { activeEntityId: 'other', panCanvasByWheel: event => panned.push(event) };
  const wheel = { deltaX: 0, deltaY: 20, ctrlKey: false, metaKey: false };
  assert.equal(routeTerminalFrameWheel(state, card, frame, wheel), true);
  assert.deepEqual(panned, [wheel]);
  state.activeEntityId = card.id;
  assert.equal(routeTerminalFrameWheel(state, card, frame, wheel), false);
  state.activeEntityId = 'other';
  assert.equal(routeTerminalFrameWheel(state, card, frame, { ...wheel, ctrlKey: true }), false);
  state.routeTerminalFrameWheel = (...args) => { assert.deepEqual(args, [card, frame, wheel]); return true; };
  assert.equal(routeTerminalFrameWheel(state, card, frame, wheel), true);
  assert.equal(panned.length, 1, 'the injected policy is the only owner when present');
});

test('unload fences pending input before closing the same owned PTY', async () => {
  const writing = deferred();
  const h = await uiFixture({ respond: async (route, body, defaults) => {
    if (route === '/terminal/write' && body.data === 'first') await writing.promise;
    return defaults(route, body);
  } }); await h.boot();
  const first = h.api.write('first'), queued = h.api.write('must not send');
  await settle(); h.event('unload'); writing.resolve();
  await first; assert.equal((await queued).skipped, true);
  assert.equal(h.requests.filter(item => item.route === '/terminal/write').length, 1);
  assert.deepEqual(h.requests.filter(item => item.route === '/terminal/kill').map(item => item.body.sessionId), ['owned-pty']);
  assert.equal(h.observer.disconnected, true);
});

test('Terminal HTML exposes only functional shell controls and existing chrome scripts', () => {
  const html = readFileSync(new URL('terminal.html', resources), 'utf8');
  for (const id of ['terminal-shell-select', 'terminal-shell-start', 'terminal-shell-label', 'terminal-operation-status']) assert.ok(html.includes('id="' + id + '"'));
  assert.match(html, /aria-label="새 터미널에서 실행할 셸"/);
  assert.equal(/\son\w+\s*=/i.test(html), false);
  assert.equal(initializer.includes("shell: '/bin/zsh'"), false);
});

test('closing during spawn observes and closes the late owned session without enabling input', async () => {
  const starting = deferred();
  const h = await uiFixture({ respond: async (route, body, defaults) => {
    if (route === '/terminal/spawn') await starting.promise;
    return defaults(route, body);
  } });
  const boot = h.boot(); await settle();
  assert.equal(h.requests.some(item => item.route === '/terminal/spawn'), true);
  assert.equal(await h.api.closeForBoard(), false);
  assert.equal((await h.api.write('must not dispatch')).skipped, true);
  starting.resolve(); await boot; await settle();
  assert.equal(h.requests.filter(item => item.route === '/terminal/kill').length, 1);
  assert.equal(h.requests.filter(item => item.route === '/terminal/write').length, 0);
  assert.equal(h.api.isConnected(), false);
  assert.equal(h.messages.some(message => message.type === 'terminal-exit-confirmed'), true);
});

test('production Card routes a shell request to a separate Card and rejects other frames and paths', () => {
  const surfaceSource = readSurfaceSource();
  const body = surfaceSource.match(/    const onTerminalReady = \(ev\) => \{([\s\S]*?)\n    \};/)?.[1];
  assert.ok(body, 'exercise the production iframe-message boundary');
  let wheelHandler;
  const ownFrame = { terminalAPI: { setWheelHandler: handler => { wheelHandler = handler; } } }, opened = [], sessionText = { textContent: '' };
  let dismissed = 0;
  const card = { id: 'terminal', dataset: {} }, state = { activeEntityId: card.id, panModifier: false };
  let focused = 0;
  const matchSource = surfaceSource.match(/^  function terminalHostMessageMatches\(event, frame, expectedUrl\) \{[\s\S]*?^  \}/m)?.[0];
  assert.ok(matchSource);
  const matches = compileFunction(matchSource + '\nreturn terminalHostMessageMatches;')();
  const terminalUrl = 'chrome://userchrome/content/terminal.html';
  ownFrame.terminalAPI.hostEventKey = 'document-key';
  const handler = compileFunction('let everConnected = false; return ev => {' + body + '\n};',
    ['termBrowser', 'spawnTerminalCard', 'sessionText', 'dismissCloseConfirm', 'focusTerminal', 'boardCloseRequests', 'card', 'completeAgendaClose', 'activate',
      'state', 'activateCard', 'routeTerminalFrameWheel', 'TAG', 'terminalHostMessageMatches', 'terminalUrl', 'terminalDisposed', 'heldPanel'])(
    { contentWindow: ownFrame, contentDocument: { documentURI: terminalUrl }, isConnected: true }, options => opened.push(options), sessionText, () => dismissed++,
    () => focused++, new Set(), card, () => assert.fail('no Board close is pending'), true,
    state, () => { if (!state.panModifier) state.activeEntityId = card.id; }, routeTerminalFrameWheel, 'test', matches, terminalUrl, false, null);
  const deliver = event => handler({ origin: 'chrome://userchrome', ...event, data: { hostEventKey: 'document-key', ...event.data } });
  deliver({ source: {}, data: { type: 'terminal-new-session', shellId: 'cmd' } });
  deliver({ source: ownFrame, data: { type: 'terminal-new-session', shellId: '/bin/zsh' } });
  assert.deepEqual(opened, []);
  deliver({ source: ownFrame, data: { type: 'terminal-new-session', shellId: 'cmd' } });
  assert.deepEqual(opened, [{ shellId: 'cmd' }]);
  assert.equal(focused, 0);
  deliver({ source: ownFrame, data: { type: 'terminal-ready', shellLabel: 'CMD' } });
  assert.equal(sessionText.textContent, 'CMD', 'the shell name is the session state beside the window name'); assert.equal(focused, 1);
  assert.equal(typeof wheelHandler, 'function');
  state.activeEntityId = 'different-card';
  deliver({ source: ownFrame, data: { type: 'terminal-ready', shellLabel: 'CMD' } });
  assert.equal(focused, 1, 'late terminal ready cannot steal focus from another card');
  deliver({ source: {}, data: { type: 'terminal-activate' } });
  assert.equal(state.activeEntityId, 'different-card', 'another iframe cannot activate this card');
  assert.equal(dismissed, 0, 'another iframe cannot withdraw this window\'s close question');
  deliver({ source: ownFrame, data: { type: 'terminal-activate' } });
  assert.equal(state.activeEntityId, card.id);
  assert.equal(dismissed, 1, 'a press inside the terminal withdraws the close question');
  state.activeEntityId = 'different-card'; state.panModifier = true;
  deliver({ source: ownFrame, data: { type: 'terminal-activate' } });
  assert.equal(state.activeEntityId, 'different-card', 'pan modifier does not activate');
});

test('Windows worker exit requires native IPC plus clean observed worker close for the same session', () => {
  const receipt = { sessionId: 'worker', status: 'EXITED', exited: true, exitConfirmed: true, httpStatus: 200,
    exitCode: 137, exitSource: 'conpty-worker.native-onExit', nativeExitConfirmed: true,
    workerCloseConfirmed: true, workerExitCode: 0, workerExitSignal: null };
  assert.equal(TerminalState.terminalExitEvidence(receipt, 'worker'), 'native-exit');
  assert.equal(TerminalState.terminalExitEvidence(receipt, 'different'), null);
  for (const field of ['nativeExitConfirmed', 'workerCloseConfirmed', 'workerExitCode', 'workerExitSignal', 'exitSource']) {
    const missing = { ...receipt }; delete missing[field];
    assert.equal(TerminalState.terminalExitEvidence(missing, 'worker'), null, field);
  }
  for (const invalid of [
    { nativeExitConfirmed: false }, { workerCloseConfirmed: false }, { workerExitCode: 1 },
    { workerExitSignal: 'SIGTERM' }, { exitSource: 'conpty-worker.close-only' },
  ]) assert.equal(TerminalState.terminalExitEvidence({ ...receipt, ...invalid }, 'worker'), null);
  const legacy = { sessionId: 'posix', status: 'EXITED', exited: true, exitConfirmed: true, httpStatus: 200, exitSource: 'pty.onExit' };
  assert.equal(TerminalState.terminalExitEvidence(legacy, 'posix'), 'native-exit');
});

test('VT status replies during composition pass through without consuming its missing native commit', async () => {
  const h = compositionFixture();
  h.gate.start(); await h.gate.data('\x1b[1;1R'); h.gate.end('한글'); h.tick(); await settle();
  assert.deepEqual(h.sent, ['\x1b[1;1R', '한글']);
  assert.equal(h.cleanups(), 1);
  assert.equal((await h.gate.data('한글')).suppressedDuplicate, true);
});

test('toolbar and close-retry buttons retain focus instead of handing it back to xterm', async () => {
  const h = await uiFixture(); await h.boot();
  const focused = h.term.focusCalls;
  h.event('mousedown', { target: { closest: selector => selector.includes('#terminal-toolbar') ? {} : null } });
  h.event('mousedown', { target: { closest: selector => selector.includes('#status-overlay button') ? {} : null } });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.term.focusCalls, focused);
  h.event('mousedown', { target: { closest: () => null } });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(h.term.focusCalls, focused + 1);
});

test('catalog failure and definite no-native spawn rejection allow Card closure without EXITED evidence', async () => {
  for (const failure of ['catalog', 'spawn']) {
    const h = await uiFixture({ respond: (route, body, defaults) => {
      if (route === (failure === 'catalog' ? '/terminal/shells' : '/terminal/spawn')) return {
        ok: false, code: 'WINDOWS_PTY_UNAVAILABLE', error: 'ConPTY unavailable', httpStatus: 503 };
      return defaults(route, body);
    } });
    await h.boot();
    assert.equal(h.api.isConnected(), false);
    assert.equal(await h.api.closeForBoard(), true);
    const killed = await h.api.kill();
    assert.deepEqual(killed, { ok: true, sessionId: null, status: 'NO_SESSION', exited: false, exitConfirmed: false });
    assert.equal(TerminalState.terminalExitEvidence({ ...killed, httpStatus: 200 }, 'unknown'), null);
    assert.equal(h.requests.some(item => item.route === '/terminal/kill'), false);
    assert.equal(h.messages.some(message => message.type === 'terminal-exit-confirmed'), false);
  }
});

test('ambiguous spawn acceptance never silently retries or permits false no-session closure', async () => {
  for (const failure of [new Error('network reply lost after submission'),
    Object.assign(new Error('spawn request timed out'), { name: 'AbortError' })]) {
    const h = await uiFixture({ respond: (route, body, defaults) => {
      if (route === '/terminal/spawn') throw failure;
      return defaults(route, body);
    } });
    await h.boot();
    assert.equal(h.api.isConnected(), false);
    assert.equal(h.elements['status-overlay'].onclick, null);
    assert.match(h.elements['status-overlay'].textContent, /중복 실행/);
    h.elements['terminal-shell-start'].dispatch('click'); await settle();
    assert.equal(h.requests.filter(item => item.route === '/terminal/spawn').length, 1);
    assert.equal(await h.api.closeForBoard(), false);
    assert.equal((await h.api.kill()).exitConfirmed, false);
  }
});

test('invalid Windows pipe receipt retains its owned session until termination is actually confirmed', async () => {
  const h = await uiFixture({ respond: (route, body, defaults) => {
    if (route === '/terminal/spawn') return { ...defaults(route, body), usePty: false, transport: 'pipe', degraded: true };
    if (route === '/terminal/kill' || route === '/terminal/read') return {
      ok: false, sessionId: body.sessionId, status: 'UNKNOWN', code: 'UNKNOWN_SESSION', exited: false, exitConfirmed: false, httpStatus: 404 };
    return defaults(route, body);
  } });
  await h.boot();
  assert.equal(h.api.ptyId, 'owned-pty');
  assert.equal(h.api.isConnected(), false);
  assert.equal(h.api.closeState().phase, 'unknown');
  assert.equal(await h.api.closeForBoard(), false);
  assert.equal(h.requests.filter(item => item.route === '/terminal/spawn').length, 1);
});

test('typed ambiguous Windows startup response never becomes NO_SESSION or a repeated spawn', async () => {
  const h = await uiFixture({ respond: (route, body, defaults) => {
    if (route === '/terminal/spawn') return { ok: false, code: 'WINDOWS_SPAWN_UNCONFIRMED',
      error: 'The worker startup result is unconfirmed', httpStatus: 503 };
    return defaults(route, body);
  } });
  await h.boot();
  assert.equal(h.api.isConnected(), false);
  assert.equal(h.elements['status-overlay'].onclick, null);
  assert.equal(h.elements['terminal-shell-start'].disabled, true);
  h.elements['terminal-shell-start'].dispatch('click'); await settle();
  assert.equal(h.requests.filter(item => item.route === '/terminal/spawn').length, 1);
  assert.equal(await h.api.closeForBoard(), false);
  const result = await h.api.kill();
  assert.equal(result.status, 'STOP_UNCONFIRMED');
  assert.equal(result.exitConfirmed, false);
  assert.equal(h.messages.some(message => message.type === 'terminal-exit-confirmed'), false);
});

const storedProject = () => ({ projectId: 'project-a', rootId: 'root-a', status: 'connected', displayPath: '/verified/project',
  scripts: [{ id: 'test', name: '검사', command: 'npm test', kind: 'test' }] });
const runRequest = () => ({ boardId: 'board-a', projectId: 'project-a', rootId: 'root-a', script: { ...storedProject().scripts[0] } });
const runNonce = line => / ([a-z0-9]{16}) "\$\?"/.exec(line)?.[1] || /\[egdesk-run:([a-z0-9]{16}):exit=/.exec(line)?.[1];

async function scriptFixture(t, { project = storedProject(), respond } = {}) {
  const stream = [];
  const h = await uiFixture({ platform: 'darwin', search: '?autofocus=0', respond: async (route, body, defaults) => {
    if (respond) { const override = await respond(route, body); if (override !== undefined) return override; }
    if (route === '/v1/files/projects/open') return { ok: true, result: { project } };
    if (route === '/terminal/read') {
      const output = stream.shift();
      if (output instanceof Error) throw output;
      return { ...defaults(route, body), data: output || '' };
    }
    return defaults(route, body);
  } });
  t.after(() => h.event('unload'));
  await h.boot();
  h.output = async data => { stream.push(data); await [...h.intervals.values()][0]?.(); await settle(); };
  h.scriptWrites = () => h.requests.filter(item => item.route === '/terminal/write');
  return h;
}

test('project run verifies the attached Board and only PTY output completes its split receipt', async t => {
  const h = await scriptFixture(t);
  assert.equal(h.term.focusCalls, 0, 'background terminals do not autofocus');
  assert.equal(h.api.inputRevision(), 0);
  assert.equal(h.scriptWrites().length, 0, 'opening a terminal never runs a project command');
  const request = runRequest();
  const pending = h.api.runScript(request);
  request.boardId = 'later-selected-board'; request.script.command = 'other command';
  let completed = false; void pending.then(() => { completed = true; });
  await settle(); await settle();
  assert.deepEqual(h.requests.filter(item => item.route === '/v1/files/projects/open').map(item => item.body),
    Array.from({ length: 2 }, () => ({ boardId: 'board-a', expectedProjectId: 'project-a', expectedRootId: 'root-a' })));
  const line = h.scriptWrites()[0].body.data, nonce = runNonce(line);
  assert.equal(h.api.inputRevision(), 0, 'owned script dispatch is distinct from human input');
  assert.ok(nonce); assert.match(line, /cd -- '\/verified\/project'/); assert.match(line, /eval 'npm test'/);
  h.term.send(`[egdesk-run:${nonce}:exit=0]`); await settle();
  assert.equal(h.api.inputRevision(), 1);
  assert.equal(completed, false, 'term.onData is input, not output evidence');
  await h.output(`${line.replace(/\r$/, '\r\n')}actual log\n[egdesk-run:${nonce}:exit=`);
  assert.equal(completed, false);
  await h.output('7]\n');
  const result = await pending;
  assert.equal(result.status, 'failed'); assert.equal(result.exitCode, 7);
  assert.equal(result.cwd, '/verified/project'); assert.equal(result.projectId, 'project-a');
  assert.equal(result.command, 'npm test'); assert.match(result.output.head, /actual log/);
  assert.doesNotMatch(result.output.head, /eval 'npm test'/);
  assert.equal(h.scriptWrites().filter(item => item.body.data.includes('eval ')).length, 1);
  assert.equal(h.term.focusCalls, 0);
  await h.api.write('human API write'); assert.equal(h.api.inputRevision(), 2);
  h.api.paste('human paste'); await settle(); assert.equal(h.api.inputRevision(), 3);
});

test('project runs reject raw paths, reassociation, edited commands and unknown shells before writing', async t => {
  for (const project of [null, { ...storedProject(), projectId: 'different' }, { ...storedProject(), rootId: 'different' },
    { ...storedProject(), status: 'reconnect-required' }, { ...storedProject(), displayPath: 'relative/path' },
    { ...storedProject(), scripts: [{ ...storedProject().scripts[0], command: 'changed' }] }]) {
    const h = await scriptFixture(t, { project });
    await assert.rejects(h.api.runScript(runRequest()), { code: 'TERMINAL_PROJECT_CHANGED' });
    assert.equal(h.scriptWrites().length, 0);
  }
  const h = await scriptFixture(t);
  await assert.rejects(h.api.runScript({ ...runRequest(), cwd: '/untrusted/path' }), { code: 'TERMINAL_RUN_REQUEST' });
  assert.equal(h.scriptWrites().length, 0);
  const cmd = await uiFixture({ search: '?shellId=cmd', respond: (route, body, defaults) => route === '/v1/files/projects/open'
    ? { ok: true, result: { project: storedProject() } } : defaults(route, body) });
  t.after(() => cmd.event('unload')); await cmd.boot();
  await assert.rejects(cmd.api.runScript(runRequest()), { code: 'TERMINAL_RUN_SHELL' });
  assert.equal(cmd.requests.some(item => item.route === '/terminal/write'), false);
});

test('disconnect keeps bounded logs with unknown status and reconnect never replays the command', async t => {
  const h = await scriptFixture(t);
  const pending = h.api.runScript(runRequest()); await settle(); await settle();
  const nonce = runNonce(h.scriptWrites()[0].body.data);
  await h.output('received before disconnect\n');
  await h.output(new Error('stream disconnected'));
  const result = await pending;
  assert.equal(result.status, 'unknown'); assert.equal(result.exitCode, null);
  assert.match(result.output.head, /received before disconnect/);
  h.elements['status-overlay'].onclick(); await settle(); await settle();
  await h.output(`[egdesk-run:${nonce}:exit=0]\n`);
  assert.equal(result.status, 'unknown'); assert.equal(h.scriptWrites().length, 1);
  assert.equal(h.requests.filter(item => item.route === '/terminal/spawn').length, 1);
});

test('pending authority lookup, wrong-session output and close cannot complete or replay a run', async t => {
  const lookup = deferred();
  const h = await scriptFixture(t, { respond: (route) => route === '/v1/files/projects/open' ? lookup.promise : undefined });
  const pending = h.api.runScript(runRequest());
  const rejected = assert.rejects(pending, { code: 'TERMINAL_INPUT_STALE' });
  await settle(); await h.api.closeForBoard();
  lookup.resolve({ ok: true, result: { project: storedProject() } }); await rejected;
  assert.equal(h.scriptWrites().length, 0);
  let mismatch = false;
  const other = await scriptFixture(t, { respond: route => mismatch && route === '/terminal/read'
    ? { ok: true, sessionId: 'foreign', status: 'RUNNING', data: 'foreign output' } : undefined });
  const running = other.api.runScript(runRequest()); await settle(); await settle();
  await assert.rejects(other.api.runScript(runRequest()), { code: 'TERMINAL_RUN_BUSY' });
  mismatch = true; await other.output('');
  assert.equal((await running).status, 'unknown');
  assert.equal(other.term.output.includes('foreign output'), false);
  assert.equal(other.scriptWrites().length, 1);
});

test('human input during either delayed project lookup prevents idle-terminal reuse dispatch without replay', async t => {
  for (const delayedLookup of [1, 2]) {
    const lookup = deferred(); let preparingReuse = false, lookups = 0;
    const h = await scriptFixture(t, { respond: route => {
      if (preparingReuse && route === '/v1/files/projects/open' && ++lookups === delayedLookup) return lookup.promise;
    } });
    // Establish a completed owned run, then reuse the same idle session.
    const first = h.api.runScript(runRequest()); await settle(); await settle();
    await h.output(`[egdesk-run:${runNonce(h.scriptWrites()[0].body.data)}:exit=0]\n`);
    assert.equal((await first).status, 'completed');
    const previousWrites = h.scriptWrites().length, sessionId = h.api.ptyId;
    preparingReuse = true;
    const pending = h.api.runScript(runRequest()).then(result => ({ result }), error => ({ error }));
    await settle(); await settle();
    assert.equal(lookups, delayedLookup);
    h.term.send('node\r'); await settle();
    assert.equal(h.api.inputRevision(), 1);
    lookup.resolve({ ok: true, result: { project: storedProject() } });
    await settle(); await settle();
    assert.equal(h.scriptWrites().slice(previousWrites).some(item => item.body.data.includes('[egdesk-run:')), false,
      'intervening human input must fence the project write before dispatch');
    const outcome = await pending;
    if (delayedLookup === 1) assert.equal(outcome.error?.code, 'TERMINAL_INPUT_STALE');
    else {
      assert.equal(outcome.result?.status, 'not-started');
      assert.equal(outcome.result?.code, 'TERMINAL_INPUT_STALE');
    }
    await h.api.write('human later\r'); await settle();
    assert.deepEqual(h.scriptWrites().slice(previousWrites).map(item => item.body.data), ['node\r', 'human later\r'],
      'zero project writes; both ordinary human inputs remain ordered and available');
    assert.equal(h.api.ptyId, sessionId); assert.equal(h.api.isConnected(), true);
    assert.equal(h.requests.filter(item => item.route === '/terminal/spawn').length, 1, 'no automatic replacement terminal');
    assert.equal(lookups, delayedLookup, 'no automatic authority lookup or command retry');
  }
});

test('collector bounds incomplete output and cancellation before start never writes', async () => {
  const nonce = 'abcdefgh12345678';
  const collector = TerminalState.createTerminalRunCollector({ nonce, headChars: 4, tailChars: 6 });
  collector.push('x'.repeat(10000));
  const output = collector.output();
  assert.equal(output.head.length, 4); assert.equal(output.tail.length, 6); assert.equal(output.omittedBytes, 9990);
  let writes = 0;
  const run = TerminalState.createTerminalScriptRun({ nonce, command: 'echo test', write: () => { writes++; } });
  run.cancel(); assert.equal((await run.start()).status, 'unknown'); assert.equal(writes, 0);
  assert.equal(run.onData(`[egdesk-run:${nonce}:exit=0]`), false);
});

test('whole typed command is folder-gated, and a comment or cd inside it cannot swallow the receipt', () => {
  const nonce = 'abcdefgh12345678';
  const execute = options => spawnSync('/bin/sh', ['-c', TerminalState.terminalScriptLine({ nonce, ...options }).replace(/\r$/, '\n')], { encoding: 'utf8' });
  if (process.platform !== 'win32') {
    const absent = execute({ cwd: '/__egdesk_nonexistent_project_fixture__', command: 'printf FIRST; printf MUST_NOT_RUN' });
    assert.doesNotMatch(absent.stdout, /FIRST|MUST_NOT_RUN/); assert.match(absent.stdout, /exit=[1-9]/);
    const safe = execute({ cwd: '/tmp', command: 'printf EXACT; cd /; exit 7 # typed comment' });
    assert.match(safe.stdout, /EXACT/); assert.match(safe.stdout, /exit=7/);
  }
  const windows = TerminalState.terminalScriptLine({ nonce, cwd: "C:\\it's here", command: 'Write-Output test', shell: 'powershell' });
  assert.match(windows, /Set-Location -LiteralPath 'C:\\it''s here' -ErrorAction Stop/);
  assert.match(windows, /try \{.*scriptblock.*catch.*finally/);
  assert.match(windows, /Set-Location -LiteralPath \$egdeskLocation.Path/);
});

test('collector timeout, cancellation and output receipt settle independently of a never-resolving write ack', async () => {
  for (const finish of ['timeout', 'cancel', 'receipt']) {
    let timeout;
    const run = TerminalState.createTerminalScriptRun({ command: 'echo check', nonce: 'abcdefgh12345678', write: () => new Promise(() => {}),
      schedule: fn => { timeout = fn; return 1; }, cancel() {} });
    const pending = run.start();
    run.onData('already received\n');
    if (finish === 'timeout') timeout();
    else if (finish === 'cancel') run.cancel();
    else run.onData('[egdesk-run:abcdefgh12345678:exit=0]\n');
    const deadline = Symbol('deadlock');
    const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve(deadline), 20))]);
    assert.notEqual(result, deadline, finish);
    assert.equal(result.status, finish === 'receipt' ? 'completed' : 'unknown');
    assert.match(result.output.head, /already received/); assert.equal(run.active, false);
  }
});

test('cancelled or expired queued script is fenced at actual dispatch, preserving later human input', async () => {
  for (const reason of ['timeout', 'cancel']) {
    const held = deferred(), sent = [];
    const queue = TerminalState.createTerminalWriteQueue({ write: async (id, data) => { sent.push(data); if (data === 'human first') await held.promise; return { ok: true }; } });
    queue.bind('one');
    const human = queue.enqueue('human first'); await settle();
    let timeout;
    const run = TerminalState.createTerminalScriptRun({ command: 'must not run', nonce: 'abcdefgh12345678',
      write: data => queue.enqueue(data, { isCurrent: () => run.active }), schedule: fn => { timeout = fn; return 1; }, cancel() {} });
    const pending = run.start(); await settle();
    if (reason === 'timeout') timeout(); else run.cancel();
    assert.equal((await pending).status, 'unknown');
    held.resolve(); await human; await queue.enqueue('human later');
    assert.deepEqual(sent, ['human first', 'human later']);
  }
});

test('project association is revalidated after queued human input and before the script transport dispatch', async t => {
  const held = deferred(); let changed = false;
  const h = await scriptFixture(t, { respond: async (route, body) => {
    if (route === '/terminal/write' && body.data === 'human first') { await held.promise; return { ok: true }; }
    if (route === '/v1/files/projects/open' && changed) return { ok: true, result: { project: { ...storedProject(), rootId: 'changed-root' } } };
  } });
  const human = h.api.write('human first'); await settle();
  const pending = h.api.runScript(runRequest()); await settle();
  changed = true; held.resolve(); await human;
  const result = await pending;
  assert.equal(result.status, 'not-started'); assert.equal(result.code, 'TERMINAL_PROJECT_CHANGED');
  assert.deepEqual(h.scriptWrites().map(item => item.body.data), ['human first']);
  assert.equal(h.api.isConnected(), true, 'authority drift is not a transport failure');
});

test('intervening human input fences a queued project run before its final authority lookup', async t => {
  const held = deferred();
  const h = await scriptFixture(t, { respond: async (route, body) => {
    if (route === '/terminal/write' && body.data === 'human first') { await held.promise; return { ok: true }; }
  } });
  const first = h.api.write('human first'); await settle();
  const pending = h.api.runScript(runRequest()); await settle(); await settle();
  const intervening = h.api.write('node\r');
  held.resolve(); await first;
  const result = await pending; await intervening;
  assert.equal(result.status, 'not-started'); assert.equal(result.code, 'TERMINAL_INPUT_STALE');
  assert.deepEqual(h.scriptWrites().map(item => item.body.data), ['human first', 'node\r']);
  assert.equal(h.requests.filter(item => item.route === '/v1/files/projects/open').length, 1,
    'stale queued scripts are rejected before final authority lookup, without automatic retry');
  assert.equal(h.api.isConnected(), true); assert.equal(h.api.inputRevision(), 2);
});

test('actual write and read transports time out, settle unknown, and invalidate queued commands without replay', async t => {
  for (const stalledRoute of ['/terminal/write', '/terminal/read']) {
    const timers = new Map(); let nextTimer = 0, stallRead = false;
    const timeouts = { set: (fn, ms) => { timers.set(++nextTimer, { fn, ms }); return nextTimer; }, clear: id => timers.delete(id) };
    const h = await uiFixture({ platform: 'darwin', timeouts, respond: (route, body, defaults, options) => {
      if (route === '/v1/files/projects/open') return { ok: true, result: { project: storedProject() } };
      if (route === stalledRoute && (route === '/terminal/write' || stallRead)) {
        assert.ok(options.signal, 'the actual HTTP request has a bounded abort signal');
        return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(Object.assign(new Error('transport timeout'), { name: 'AbortError' }))));
      }
      return defaults(route, body);
    } });
    t.after(() => h.event('unload')); await h.boot();
    const pending = h.api.runScript(runRequest()); await settle(); await settle();
    let reading;
    if (stalledRoute === '/terminal/read') { stallRead = true; reading = [...h.intervals.values()][0](); await settle(); }
    const delayed = [...timers.values()].find(timer => timer.ms === (stalledRoute === '/terminal/write' ? 10000 : 5000));
    assert.ok(delayed); delayed.fn(); await settle();
    if (reading) await reading;
    const result = await pending;
    assert.equal(result.status, 'unknown'); assert.equal(result.exitCode, null); assert.equal(h.api.isConnected(), false);
    assert.equal((await h.api.write('must not replay')).skipped, true);
    assert.equal(h.requests.filter(item => item.route === '/terminal/write').length, 1);
  }
});


test('each terminal document publishes its own key before its first host event and binds every event to it', async () => {
  const first = await uiFixture();
  assert.equal(first.api.hostEventKey, first.hostEventKey);
  assert.deepEqual(first.messages[0], { type: 'terminal-api-ready', hostEventKey: first.api.hostEventKey });
  await first.boot();
  first.elements['terminal-shell-select'].value = 'cmd';
  first.elements['terminal-shell-start'].dispatch('click');
  first.event('mousedown', {});
  assert.ok(first.messages.length >= 4);
  assert.ok(first.messages.every(message => message.hostEventKey === first.api.hostEventKey));
  const second = await uiFixture();
  assert.notEqual(second.api.hostEventKey, first.api.hostEventKey, 'a reload cannot reuse the previous document key');
  assert.match(second.api.hostEventKey, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('managed idle Terminal neither spawns nor attaches until the user chooses; attach does not send device replies', async () => {
  const bridgeInstance = crypto.randomUUID();
  const ref = { sessionId: 'held-pty', bridgeInstance };
  const h = await uiFixture({ search: '?managed=1', respond(route, body, defaults) {
    if (route === '/terminal/attach') return { ...ref, ok: true, status: 'RUNNING', usePty: true, transport: 'conpty', detachSupported: true };
    if (route === '/terminal/read') return { ...defaults(route, body), data: 'synthetic PTY output' };
    return defaults(route, body);
  } });
  await h.boot();
  assert.equal(h.requests.length, 0);
  h.api.configureLocal(h.fetch, true); await settle();
  assert.deepEqual(h.requests.map(r => r.route), ['/terminal/shells']);
  assert.equal(h.elements['terminal-shell-start'].textContent, '새 터미널 열기');
  assert.deepEqual(await h.api.attachLocal(ref), { ok: true }); await settle();
  assert.equal(h.api.ptyId, ref.sessionId);
  assert.equal(h.api.isConnected(), true);
  assert.deepEqual(h.requests.map(r => r.route), ['/terminal/shells', '/terminal/attach', '/terminal/read']);
  assert.deepEqual(h.term.output, ['synthetic PTY output']);
  assert.equal(h.messages.find(m => m.type === 'terminal-ready').resumed, true);
  await h.api.write('explicit input');
  assert.deepEqual(h.requests.at(-1).body, { sessionId: ref.sessionId, data: 'explicit input' });
});

test('managed idle Terminal never starts a shell on failed re-entry; only the separate new action does', async () => {
  const ref = { sessionId: 'held-pty', bridgeInstance: crypto.randomUUID() };
  const h = await uiFixture({ search: '?managed=1', respond(route, body, defaults) {
    if (route === '/terminal/attach') return { ok: false, code: 'TERMINAL_BRIDGE_RESTARTED', httpStatus: 400 };
    return defaults(route, body);
  } });
  await h.boot(); h.api.configureLocal(h.fetch, true); await settle();
  assert.equal((await h.api.attachLocal(ref)).code, 'TERMINAL_BRIDGE_RESTARTED');
  assert.equal(h.requests.filter(r => r.route === '/terminal/spawn').length, 0);
  h.elements['terminal-shell-start'].dispatch('click'); await settle();
  assert.equal(h.requests.filter(r => r.route === '/terminal/spawn').length, 1);
  assert.equal(h.api.ptyId, 'owned-pty');
});

test('managed detach waits for a matching hold ACK and unload never kills a held PTY', async () => {
  const bridgeInstance = crypto.randomUUID();
  const ack = deferred();
  const h = await uiFixture({ search: '?managed=1', respond(route, body, defaults) {
    if (route === '/terminal/spawn') return { ...defaults(route, body), bridgeInstance, detachSupported: true };
    if (route === '/terminal/detach') return ack.promise;
    return defaults(route, body);
  } });
  await h.boot(); h.api.configureLocal(h.fetch, false); await settle();
  assert.equal(h.api.canDetach(), true);
  const pending = h.api.detachLocal();
  assert.equal(h.api.ptyId, 'owned-pty');
  assert.equal((await h.api.write('stale input')).skipped, true);
  ack.resolve({ ok: true, status: 'HELD', sessionId: 'owned-pty', bridgeInstance, expiresAt: 12345 });
  assert.equal((await pending).ok, true);
  assert.equal(h.api.ptyId, null);
  h.event('unload'); await settle();
  assert.equal(h.intervals.size, 0);
  assert.equal(h.observer.disconnected, true);
  assert.equal(h.requests.some(r => r.route === '/terminal/kill' || r.route === '/terminal/write'), false);
});

test('c34: a read that carries openUrls tells the host once (terminal-open-url), a read without them says nothing', async () => {
  let reads = 0;
  const h = await uiFixture({ search: '?managed=1', respond(route, body, defaults) {
    if (route === '/terminal/attach') return { sessionId: 'held-pty', bridgeInstance: body.bridgeInstance, ok: true, status: 'RUNNING', usePty: true, transport: 'conpty', detachSupported: true };
    if (route === '/terminal/read') return { ...defaults(route, body), data: 'x', ...(++reads === 1 ? { openUrls: ['https://claude.com/cai/oauth/authorize?state=s', 'https://a.example/2', 'https://a.example/3', 'https://a.example/4', 'https://a.example/5'] } : {}) };
    return defaults(route, body);
  } });
  await h.boot(); h.api.configureLocal(h.fetch, true); await settle();
  await h.api.attachLocal({ sessionId: 'held-pty', bridgeInstance: crypto.randomUUID() }); await settle();
  const posted = h.messages.filter(m => m.type === 'terminal-open-url');
  assert.equal(posted.length, 1); assert.equal(posted[0].sessionId, 'held-pty'); assert.equal(posted[0].urls.length, 4, 'at most four');
  assert.equal(posted[0].urls[0], 'https://claude.com/cai/oauth/authorize?state=s');
});

// ---- c35 desk UX fixes ----
const darwinFixture = (extra = {}) => uiFixture({ platform: 'darwin', transport: 'pty', ...extra });
test('c35: a pipe session is never asked to resize and shows no resize error (logged once); a PTY session still resizes', async () => {
  const pipe = await darwinFixture({ respond: (route, body, defaults) => (route === '/terminal/spawn' ? { ...defaults(route, body), usePty: false, transport: 'pipe' } : defaults(route, body)) });
  await pipe.boot()
  assert.equal(pipe.api.sessionInfo().usePty, false)
  const before = pipe.requests.length
  assert.deepEqual(await pipe.api.resize(100, 30), { ok: true, resized: false, skipped: 'pipe' }); await pipe.api.resize(90, 20)
  assert.equal(pipe.requests.filter(r => r.route === '/terminal/resize').length, 0, 'nothing is sent to the bridge')
  assert.ok(!/적용하지 못했습니다|Pipe terminal sessions/.test(pipe.elements['terminal-operation-status'].textContent), 'no resize error text (the one-line pipe notice at connect is the existing Korean notice)')
  assert.equal(pipe.warnings.filter(w => String(w[0]).includes('resize skipped')).length, 1, 'logged once')
  assert.equal(pipe.requests.length, before)
  const pty = await darwinFixture(); await pty.boot()
  assert.equal((await pty.api.resize(100, 30)).resized, true); assert.equal(pty.requests.filter(r => r.route === '/terminal/resize').length >= 1, true)
})

test('c35: a click on an address in the terminal opens it in an EG-Desk Browser Card when the bridge says so (the shell catalog\'s openUrl); otherwise xterm\'s default', async () => {
  const on = { handler: null }, off = { handler: null }, opened = []
  const flagged = await darwinFixture({ webLinks: on, respond: (route, body, defaults) => (route === '/terminal/shells' ? { ...defaults(route, body), openUrl: true } : defaults(route, body)) })
  await flagged.boot(); let prevented = 0
  on.handler({ preventDefault: () => { prevented++; } }, 'https://claude.com/cai/oauth/authorize?state=s')
  const posted = flagged.messages.filter(m => m.type === 'terminal-open-url')
  assert.equal(posted.length, 1); assert.deepEqual(posted[0].urls, ['https://claude.com/cai/oauth/authorize?state=s']); assert.equal(posted[0].sessionId, 'owned-pty'); assert.equal(prevented, 1)
  const plain = await darwinFixture({ webLinks: off }); plain.window.open = (...args) => opened.push(args)
  await plain.boot(); off.handler({ preventDefault() {} }, 'https://example.test/x')
  assert.equal(plain.messages.filter(m => m.type === 'terminal-open-url').length, 0); assert.deepEqual(opened.map(a => a[0]), ['https://example.test/x'])
})

test('c35: the terminal reports how long it has been quiet (null until it printed something): the login line waits for the shell', async () => {
  const h = await darwinFixture({ respond: (route, body, defaults) => (route === '/terminal/read' ? { ...defaults(route, body), data: 'prompt % ' } : defaults(route, body)) })
  assert.equal(h.api.outputIdleMs(), null)
  await h.boot(); await settle()
  assert.ok(Number.isFinite(h.api.outputIdleMs()) && h.api.outputIdleMs() >= 0)
})

test('u1: the terminal reports whether the shell\'s line editor is up (xterm bracketed paste mode); null when it cannot tell', async () => {
  const h = await darwinFixture()
  await h.boot(); await settle()
  assert.equal(h.api.lineEditorReady(), null, 'a terminal without modes cannot tell')
  h.term.modes = { bracketedPasteMode: false }; assert.equal(h.api.lineEditorReady(), false, 'start-up files still running')
  h.term.modes = { bracketedPasteMode: true }; assert.equal(h.api.lineEditorReady(), true, 'the editor switched bracketed paste on at its prompt')
  h.term.modes = { bracketedPasteMode: 'yes' }; assert.equal(h.api.lineEditorReady(), null)
  h.term.modes = { get bracketedPasteMode() { throw new Error('gone'); } }; assert.equal(h.api.lineEditorReady(), null)
})
