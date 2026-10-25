import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import { readSurfaceSource } from './egdesk-surface-source.mjs';
import * as TerminalState from '../overlay/resources/EGDeskTerminalState.sys.mjs';

const resources = new URL('../overlay/resources/', import.meta.url);
const initializer = readFileSync(new URL('egdesk-terminal-init.js', resources), 'utf8');
const settle = async () => { for (let count = 0; count < 12; count++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

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

async function uiFixture({ search = '', platform = 'win32', transport = 'conpty', respond = null } = {}) {
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
    onData(fn) { this.send = fn; }
    write(data) { this.output.push(data); }
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
    const value = respond ? await respond(route, body, defaults) : defaults(route, body);
    const status = value.httpStatus || 200;
    return { ok: status >= 200 && status < 300, status, json: async () => value };
  };
  const window = { location: { search }, parent: { postMessage: value => messages.push(value) },
    setTimeout, addEventListener: (type, fn) => windowListeners.set(type, fn) };
  const document = { getElementById: id => elements[id], createElement: () => new Element() };
  const source = initializer.replace("await import('chrome://userchrome/content/EGDeskTerminalState.sys.mjs')", 'TerminalState')
    .replace('(async () => {', 'return (async () => {');
  assert.notEqual(source, initializer);
  const run = compileFunction(source, ['TerminalState', 'Terminal', 'FitAddon', 'WebLinksAddon', 'document', 'window', 'fetch',
    'requestAnimationFrame', 'ResizeObserver', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'AbortController', 'URLSearchParams', 'console']);
  await run(TerminalState, FakeTerminal, { FitAddon: class { fit() {} } }, undefined, document, window, fetch,
    fn => frames.push(fn), class { constructor(fn) { observer = this; this.callback = fn; } observe() {} disconnect() { this.disconnected = true; } },
    setTimeout, clearTimeout, fn => { intervals.set(++intervalId, fn); return intervalId; }, id => intervals.delete(id),
    AbortController, URLSearchParams, { warn: (...args) => warnings.push(args) });
  const h = { elements, requests, messages, term, window, intervals, warnings, observer,
    api: window.terminalAPI, boot: async () => { await frames.shift()(); await settle(); },
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
  assert.deepEqual(h.messages.at(-1), { type: 'terminal-new-session', shellId: 'cmd' });
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
  const ownFrame = {}, opened = [], title = { textContent: '' };
  let focused = 0;
  const handler = compileFunction('return ev => {' + body + '\n};',
    ['termBrowser', 'spawnTerminalCard', 'header', 'focusTerminal', 'boardCloseRequests', 'card', 'completeAgendaClose'])(
    { contentWindow: ownFrame }, options => opened.push(options), { querySelector: () => title },
    () => focused++, new Set(), { dataset: {} }, () => assert.fail('no Board close is pending'));
  handler({ source: {}, data: { type: 'terminal-new-session', shellId: 'cmd' } });
  handler({ source: ownFrame, data: { type: 'terminal-new-session', shellId: '/bin/zsh' } });
  assert.deepEqual(opened, []);
  handler({ source: ownFrame, data: { type: 'terminal-new-session', shellId: 'cmd' } });
  assert.deepEqual(opened, [{ shellId: 'cmd' }]);
  assert.equal(focused, 0);
  handler({ source: ownFrame, data: { type: 'terminal-ready', shellLabel: 'CMD' } });
  assert.equal(title.textContent, '>_ CMD'); assert.equal(focused, 1);
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
