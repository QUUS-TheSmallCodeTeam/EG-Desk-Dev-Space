import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import * as FirstRun from '../overlay/resources/EGDeskFirstRun.sys.mjs';
import { readRootProperties } from '../overlay/resources/EGDeskDesignTokens.sys.mjs';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const surfaceSource = read('../overlay/JS/eg-desk-surface.uc.js');
const surfaceCss = read('../overlay/CSS/eg-desk-surface.uc.css');
const startPage = read('../overlay/resources/egdesk-start.html');
const startScript = read('../overlay/resources/egdesk-start.js');
const START_URI = 'chrome://userchrome/content/egdesk-start.html';

test('only the EG-Desk start page document counts as a start-page event source', () => {
  const startDoc = { nodeType: 9, documentURI: START_URI };
  const webDoc = { nodeType: 9, documentURI: 'https://example.test/egdesk-start.html' };
  assert.equal(FirstRun.startPageEventDocument({ target: startDoc }, START_URI), startDoc);
  assert.equal(FirstRun.startPageEventDocument({ target: { nodeType: 1, ownerDocument: startDoc } }, START_URI), startDoc);
  assert.equal(FirstRun.startPageEventDocument({ target: webDoc }, START_URI), null);
  assert.equal(FirstRun.startPageEventDocument({ target: { nodeType: 9, documentURI: `${START_URI}#desk` } }, START_URI), null);
  assert.equal(FirstRun.startPageEventDocument({ target: { nodeType: 1, ownerDocument: webDoc } }, START_URI), null);
  assert.equal(FirstRun.startPageEventDocument({}, START_URI), null);
  assert.equal(FirstRun.startPageEventDocument(null, START_URI), null);
  assert.equal(FirstRun.startPageEventDocument({ target: startDoc }, ''), null);
});

test('the start page offers Desk 시작 only inside the first Browser while it fills the window', () => {
  const entry = FirstRun.startPageDeskEntry;
  assert.equal(entry({ initialBrowserFocus: true, browserCardId: 'b1', cardId: 'b1' }), 'available');
  assert.equal(entry({ initialBrowserFocus: false, browserCardId: 'b1', cardId: 'b1' }), '');
  assert.equal(entry({ initialBrowserFocus: true, browserCardId: 'b1', cardId: 'b2' }), '');
  assert.equal(entry({ initialBrowserFocus: true, browserCardId: null, cardId: null }), '');
  assert.equal(entry({ initialBrowserFocus: 'yes', browserCardId: 'b1', cardId: 'b1' }), '');
  assert.equal(entry(), '');
});

test('Codex connection reads as 연결 필요 / 연결 중 / 연결됨 / 확인 필요, and unknown before the bridge answers', () => {
  const state = FirstRun.codexConnectionState;
  const loggedOut = { isLoggedIn: false, loginInProgress: false };
  assert.equal(state({ connected: false, authStatus: loggedOut }), 'unknown', 'the boot default is not a login verdict');
  assert.equal(state({ authStatus: loggedOut }), 'unknown');
  assert.equal(state(null), 'unknown');
  assert.equal(state({ connected: true, authStatus: loggedOut }), 'needed');
  assert.equal(state({ connected: true, authStatus: { ...loggedOut, access: { state: 'loginRequired' } } }), 'needed');
  assert.equal(state({ connected: true, isStartingLogin: true, authStatus: loggedOut }), 'connecting');
  assert.equal(state({ connected: true, authStatus: { isLoggedIn: false, loginInProgress: true } }), 'connecting');
  assert.equal(state({ connected: true, authStatus: { isLoggedIn: false, access: { state: 'loginInProgress' } } }), 'connecting');
  assert.equal(state({ connected: true, authStatus: { isLoggedIn: false, access: { state: 'authFailed' } } }), 'check');
  assert.equal(state({ connected: true, authStatus: { isLoggedIn: true, access: { state: 'authFailed' } } }), 'check');
  assert.equal(state({ connected: true, authStatus: { isLoggedIn: true } }), 'connected');
  assert.equal(state({ connected: true, authStatus: { isLoggedIn: true, access: { state: 'ok' } } }), 'connected');
  // A used-up quota or a missing permission is not a sign-in problem.
  assert.equal(state({ connected: true, authStatus: { isLoggedIn: true, access: { state: 'quotaExhausted' } } }), 'connected');
  assert.equal(state({ connected: true, authStatus: { isLoggedIn: true, access: { state: 'permissionDenied' } } }), 'connected');
});

test('the first Desk entry shows one quiet connection line only when Codex needs it', () => {
  const notice = FirstRun.firstEntryConnectionNotice;
  const needed = { connected: true, authStatus: { isLoggedIn: false } };
  assert.deepEqual(notice({ entered: true, closed: false, codex: needed }),
    { state: 'needed', text: 'Codex 연결 필요', action: 'login', actionLabel: '로그인' });
  assert.equal(notice({ entered: false, closed: false, codex: needed }), null, 'not before the Desk is entered');
  assert.equal(notice({ entered: true, closed: true, codex: needed }), null, 'never again once closed');
  assert.equal(notice({ entered: true, closed: false, codex: { connected: false, authStatus: { isLoggedIn: false } } }), null);
  assert.equal(notice({ entered: true, closed: false, codex: { connected: true, authStatus: { isLoggedIn: true } } }), null,
    'a connected account is not asked again');
  assert.deepEqual(notice({ entered: true, closed: false, codex: { ...needed, isStartingLogin: true } }),
    { state: 'connecting', text: 'Codex 연결 중…', action: null, actionLabel: '' });
  assert.deepEqual(notice({ entered: true, closed: false, codex: { connected: true, authStatus: { isLoggedIn: true, access: { state: 'authFailed' } } } }),
    { state: 'check', text: 'Codex 연결 확인 필요', action: 'settings', actionLabel: '계정 설정' });
  assert.equal(notice(), null);
  assert.equal(FirstRun.firstEntryConnectionSettled({ connected: true, authStatus: { isLoggedIn: true } }), true);
  assert.equal(FirstRun.firstEntryConnectionSettled(needed), false);
  assert.equal(FirstRun.firstEntryConnectionSettled({ connected: false, authStatus: { isLoggedIn: true } }), false);
});

// ---- Start page ----

test('the start page uses the approved light-dark pairs of the surface tokens', () => {
  const light = readRootProperties(surfaceCss, { scheme: 'light' });
  const dark = readRootProperties(surfaceCss, { scheme: 'dark' });
  assert.match(startPage, /color-scheme:\s*light dark/);
  const pairs = {
    '--eg-window': '--egd-surface-elevated',
    '--eg-ink': '--egd-on-surface',
    '--eg-muted': '--egd-on-surface-variant',
    '--eg-accent': '--egd-primary',
    '--eg-line': '--egd-outline',
    '--eg-hover': '--egd-hover',
  };
  for (const [pageToken, surfaceToken] of Object.entries(pairs)) {
    const pair = startPage.match(new RegExp(`${pageToken}:\\s*light-dark\\((#[0-9A-Fa-f]{6}),\\s*(#[0-9A-Fa-f]{6})\\)`));
    assert.ok(pair, `${pageToken} must be a light-dark() pair`);
    assert.equal(pair[1].toUpperCase(), light[surfaceToken].toUpperCase(), `${pageToken} light`);
    assert.equal(pair[2].toUpperCase(), dark[surfaceToken].toUpperCase(), `${pageToken} dark`);
  }
  const style = startPage.match(/<style>([\s\S]*?)<\/style>/)[1];
  const outsideTokens = style.replace(/:root \{[^}]*\}/, '');
  assert.doesNotMatch(outsideTokens, /#[0-9A-Fa-f]{3,8}\b|rgba?\(/, 'colours come from the token pairs only');
  assert.doesNotMatch(startPage, /#f7f9fa|#26333d|#586873/i, 'the old fixed blue-grey is gone');
  assert.match(style, /body \{[^}]*background: var\(--eg-window\)[^}]*color: var\(--eg-ink\)/);
});

test('the start page has a Desk 시작 button that stays hidden until the Desk says it is available', () => {
  assert.match(startPage, /<button id="start-desk" type="button">Desk 시작<\/button>/);
  assert.match(startPage, /자료와 도구를 펼치려면 Desk 시작을 누르세요\. 열어 둔 웹페이지는 그대로 남습니다\./);
  assert.match(startPage, /:root:not\(\[data-desk-entry="available"\]\) \.desk-entry \{ display: none; \}/);
  assert.match(startPage, /#start-desk:hover/);
  assert.match(startPage, /#start-desk:active/);
  assert.match(startPage, /#start-desk:focus-visible \{[^}]*outline:/);
  assert.match(startPage, /@media \(prefers-reduced-motion: reduce\) \{[^}]*transition: none/);
  assert.match(startPage, /<script src="chrome:\/\/userchrome\/content\/egdesk-start\.js"><\/script>/);
  assert.doesNotMatch(startPage, /<script>|onclick=/, 'no inline script in a chrome page');
  assert.equal(FirstRun.START_PAGE_ENTRY_ATTRIBUTE, 'data-desk-entry');
});

test('the start page script only announces itself and the click; it reaches for nothing else', () => {
  const listeners = {}, sent = [];
  const button = { addEventListener: (type, fn) => { listeners[`button:${type}`] = fn; } };
  const document = {
    getElementById: id => id === 'start-desk' ? button : null,
    dispatchEvent: event => { sent.push(event); return true; },
  };
  class CustomEvent { constructor(type, init) { this.type = type; this.bubbles = init?.bubbles === true; } }
  compileFunction(startScript, ['document', 'CustomEvent'])(document, CustomEvent);
  assert.deepEqual(sent.map(event => [event.type, event.bubbles]), [[FirstRun.START_PAGE_READY_EVENT, true]]);
  listeners['button:click']();
  assert.deepEqual(sent.map(event => [event.type, event.bubbles]),
    [[FirstRun.START_PAGE_READY_EVENT, true], [FirstRun.START_PAGE_DESK_EVENT, true]]);
  assert.doesNotMatch(startScript, /ChromeUtils|Services|Components|topChromeWindow|docShell|__egdesk|fetch\(|import\(/);
});

// ---- Surface wiring ----

function firstRunBlock() {
  const block = surfaceSource.match(/  \/\/ ---- First run: the visible way to the Desk ----\n([\s\S]*?)\n  \/\/ ---- end first run ----/)?.[1];
  assert.ok(block, 'first-run block');
  return block;
}

function makeNode(tag = 'div') {
  const node = {
    tag, children: [], dataset: {}, attributes: {}, listeners: {}, hidden: false, parent: null, isConnected: true,
    append(...items) { for (const item of items) { if (item == null) continue; item.parent = node; node.children.push(item); } },
    replaceChildren(...items) { node.children = []; node.append(...items); },
    remove() { if (node.parent) node.parent.children = node.parent.children.filter(child => child !== node); node.parent = null; node.isConnected = false; },
    setAttribute(name, value) { node.attributes[name] = String(value); },
    removeAttribute(name) { delete node.attributes[name]; },
    getAttribute(name) { return node.attributes[name] ?? null; },
    addEventListener(type, fn) { node.listeners[type] = fn; },
    querySelector(selector) {
      const wanted = selector.replace(/^\./, '');
      const walk = current => {
        for (const child of current.children) {
          if (child.className?.split(' ').includes(wanted) || child.id === wanted.replace(/^#/, '')) return child;
          const found = walk(child);
          if (found) return found;
        }
        return null;
      };
      return walk(node);
    },
    contains(other) { return other === node || node.children.some(child => child.contains?.(other)); },
    focus() { node.focused = true; },
  };
  return node;
}

function harness({ codex = { connected: false, authStatus: { isLoggedIn: false } } } = {}) {
  const rootClasses = new Set(['egd-initial-browser-focus']);
  const byId = new Map();
  const el = (tag, props = {}, ...children) => {
    const node = makeNode(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'id') { node.id = value; }
      else if (key === 'data') Object.assign(node.dataset, value);
      else if (key.startsWith('on') && typeof value === 'function') node.listeners[key.slice(2).toLowerCase()] = value;
      else node.attributes[key] = String(value);
    }
    for (const child of children) node.append(typeof child === 'string' ? { text: child, children: [] } : child);
    return node;
  };
  const toolbar = makeNode(); toolbar.className = 'egd-card-toolbar';
  const startDoc = { nodeType: 9, documentURI: START_URI, documentElement: makeNode('html') };
  const card = makeNode(); card.id = 'browser-1'; card.className = 'egd-canvas-card egd-browser-card';
  card.append(toolbar); card._xulBrowser = { contentDocument: startDoc };
  const otherDoc = { nodeType: 9, documentURI: START_URI, documentElement: makeNode('html') };
  const other = makeNode(); other.id = 'browser-2'; other._xulBrowser = { contentDocument: otherDoc };
  const webDoc = { nodeType: 9, documentURI: 'https://example.test/', documentElement: makeNode('html') };
  const web = makeNode(); web.id = 'browser-3'; web._xulBrowser = { contentDocument: webDoc };
  byId.set(card.id, card);
  const root = makeNode('html');
  root.classList = { contains: name => rootClasses.has(name) };
  const realAppend = root.append;
  root.appendChild = node => { realAppend(node); if (node.id) byId.set(node.id, node); return node; };
  const windowListeners = {};
  let observed = null, entered = 0, logins = 0, settings = [], unsubscribed = 0, codexListener = null;
  const state = { surface: { initialBrowserFocus: true, browserCardId: card.id }, codex,
    codexBridge: { subscribe: fn => { codexListener = fn; return () => { unsubscribed++; codexListener = null; }; }, startLogin: () => { logins++; } } };
  const document = { documentElement: root,
    getElementById: id => { const node = byId.get(id); return node?.isConnected ? node : null; },
    querySelectorAll: selector => selector === '.egd-browser-card' ? [card, other, web] : [] };
  const window = { addEventListener: (type, fn, capture, untrusted) => { windowListeners[type] = { fn, capture, untrusted }; } };
  class MutationObserver { constructor(fn) { observed = { fn }; } observe(target, options) { observed.target = target; observed.options = options; } }
  const enterLocalDesk = () => {
    if (!state.surface.initialBrowserFocus) return false;
    entered++; state.surface.initialBrowserFocus = false; rootClasses.delete('egd-initial-browser-focus'); return true;
  };
  const install = compileFunction(`${firstRunBlock()}\nreturn installFirstRunDeskEntry;`,
    ['ChromeUtils', 'state', 'document', 'window', 'MutationObserver', 'el', 'deskIcon', 'enterLocalDesk', 'spawnSettingsCard', 'EGDESK_START_URI'])(
    { importESModule: () => FirstRun }, state, document, window, MutationObserver, el, name => ({ icon: name, children: [] }),
    enterLocalDesk, options => { settings.push(options); }, START_URI);
  return { install, state, card, toolbar, startDoc, otherDoc, webDoc, root, rootClasses, windowListeners, byId,
    observed: () => observed, entered: () => entered, logins: () => logins, settings, unsubscribed: () => unsubscribed,
    codexChanged: () => codexListener?.(), hasCodexListener: () => !!codexListener,
    notice: () => document.getElementById('egd-first-entry-notice') };
}

test('first run puts a labelled Desk button on the Browser header and Desk 시작 on the start page', () => {
  const h = harness();
  h.install();
  const button = h.toolbar.querySelector('.egd-first-run-desk');
  assert.ok(button, 'the header gets a Desk button');
  assert.equal(button.attributes.type, 'button');
  assert.equal(button.attributes.title, 'Desk 시작 — 열어 둔 웹페이지는 그대로 남습니다');
  assert.equal(button.dataset.testid, 'first-run-desk-entry');
  assert.deepEqual(button.children.map(child => child.icon || child.children[0]?.text), ['desk', 'Desk']);
  assert.equal(h.startDoc.documentElement.attributes['data-desk-entry'], 'available');
  assert.equal(h.otherDoc.documentElement.attributes['data-desk-entry'], undefined, 'another Browser showing the start page gets no button');
  assert.equal(h.webDoc.documentElement.attributes['data-desk-entry'], undefined, 'a web page is never marked');
  assert.deepEqual(h.observed().options, { attributes: true, attributeFilter: ['class'] });
  assert.equal(h.observed().target, h.root);
  h.install();
  assert.equal(h.toolbar.children.filter(child => child.className === 'egd-first-run-desk').length, 1, 'never a second button');

  let stopped = 0;
  button.listeners.click({ stopPropagation: () => { stopped++; } });
  assert.equal(stopped, 1);
  assert.equal(h.entered(), 1, 'the header button uses the existing Desk entry');
  h.observed().fn();
  assert.equal(h.startDoc.documentElement.attributes['data-desk-entry'], undefined, 'Desk 시작 leaves the page once the Desk is open');
});

test('Desk 시작 on the start page enters the Desk; the same event from any other page does nothing', () => {
  const h = harness();
  h.install();
  const ready = h.windowListeners[FirstRun.START_PAGE_READY_EVENT], desk = h.windowListeners[FirstRun.START_PAGE_DESK_EVENT];
  assert.equal(ready.capture, true); assert.equal(ready.untrusted, true);
  assert.equal(desk.capture, true); assert.equal(desk.untrusted, true);
  desk.fn({ target: h.webDoc });
  desk.fn({ target: { nodeType: 9, documentURI: `${START_URI}?x` } });
  assert.equal(h.entered(), 0, 'web content cannot open the Desk');
  desk.fn({ target: h.otherDoc });
  assert.equal(h.entered(), 0, 'only the first Browser, while it fills the window');
  // A reload of the start page announces itself again and is marked again.
  h.startDoc.documentElement.removeAttribute('data-desk-entry');
  ready.fn({ target: h.startDoc });
  assert.equal(h.startDoc.documentElement.attributes['data-desk-entry'], 'available');
  desk.fn({ target: h.startDoc });
  assert.equal(h.entered(), 1);
  desk.fn({ target: h.startDoc });
  assert.equal(h.entered(), 1, 'nothing happens once the Desk is open');
});

test('entering the Desk shows one quiet Codex line, which logs in, follows the state and closes for good', () => {
  const codex = { connected: false, authStatus: { isLoggedIn: false } };
  const h = harness({ codex });
  h.install();
  assert.equal(h.notice(), null, 'nothing while the first Browser fills the window');
  h.state.surface.initialBrowserFocus = false; h.rootClasses.delete('egd-initial-browser-focus');
  h.observed().fn();
  assert.equal(h.notice(), null, 'the bridge has not answered yet, so nothing is claimed');
  assert.ok(h.hasCodexListener());
  codex.connected = true;
  h.codexChanged();
  const line = h.notice();
  assert.ok(line);
  assert.equal(line.attributes.role, 'status');
  assert.equal(line.dataset.state, 'needed');
  assert.equal(line.dataset.testid, 'first-entry-connection');
  assert.equal(line.querySelector('.egd-first-entry-text').children[0].text, 'Codex 연결 필요');
  const login = line.querySelector('.egd-first-entry-action');
  assert.equal(login.children[0].text, '로그인');
  h.codexChanged();
  assert.equal(h.notice(), line, 'an unchanged state does not rebuild the line under the pointer');
  login.listeners.click();
  assert.equal(h.logins(), 1);
  codex.isStartingLogin = true;
  h.codexChanged();
  assert.equal(h.notice().dataset.state, 'connecting');
  assert.equal(h.notice().querySelector('.egd-first-entry-text').children[0].text, 'Codex 연결 중…');
  assert.equal(h.notice().querySelector('.egd-first-entry-action'), null);
  codex.isStartingLogin = false; codex.authStatus = { isLoggedIn: true };
  h.codexChanged();
  assert.equal(h.notice(), null, 'a connected account needs no line');
  assert.equal(h.unsubscribed(), 1);
  assert.equal(h.hasCodexListener(), false);

  const h2 = harness({ codex: { connected: true, authStatus: { isLoggedIn: false } } });
  h2.install();
  h2.state.surface.initialBrowserFocus = false; h2.rootClasses.delete('egd-initial-browser-focus');
  h2.observed().fn();
  const close = h2.notice().querySelector('.egd-first-entry-close');
  assert.equal(close.attributes['aria-label'], '연결 안내 닫기');
  close.listeners.click();
  assert.equal(h2.notice(), null);
  assert.equal(h2.unsubscribed(), 1);
  h2.observed().fn();
  assert.equal(h2.notice(), null, 'closed once, it does not come back');

  const h3 = harness({ codex: { connected: true, authStatus: { isLoggedIn: false } } });
  h3.install();
  h3.state.surface.initialBrowserFocus = false; h3.rootClasses.delete('egd-initial-browser-focus');
  h3.observed().fn();
  let prevented = 0;
  h3.notice().listeners.keydown({ key: 'Escape', preventDefault: () => { prevented++; }, stopPropagation() {} });
  assert.equal(prevented, 1);
  assert.equal(h3.notice(), null, 'Esc inside the line closes it');

  const h4 = harness({ codex: { connected: true, authStatus: { isLoggedIn: true, access: { state: 'authFailed' } } } });
  h4.install();
  h4.state.surface.initialBrowserFocus = false; h4.rootClasses.delete('egd-initial-browser-focus');
  h4.observed().fn();
  h4.notice().querySelector('.egd-first-entry-action').listeners.click();
  assert.deepEqual(h4.settings, [{ tab: 'account' }]);
});

test('a Desk that was never in first-run focus gets neither the button nor the line', () => {
  const h = harness({ codex: { connected: true, authStatus: { isLoggedIn: false } } });
  h.state.surface.initialBrowserFocus = false; h.rootClasses.delete('egd-initial-browser-focus');
  h.install();
  assert.equal(h.toolbar.querySelector('.egd-first-run-desk'), null);
  assert.equal(h.startDoc.documentElement.attributes['data-desk-entry'], undefined);
  h.observed().fn();
  assert.equal(h.notice(), null, 'a returning Desk is not a first entry');
  assert.equal(h.hasCodexListener(), false);
});

test('boot installs first run after the first Browser is focused, without changing the QA contract', () => {
  assert.match(surfaceSource, /restoreSurfaceEntry\(lifecycle, deskSession, legacyStore\);\n      installFirstRunDeskEntry\(\);/);
  assert.match(surfaceSource, /surface: \{\n          enterDesk: enterLocalDesk,/);
});

test('the Desk button shows only in first-run focus and the line stays out of fullscreen, in tokens only', () => {
  const rule = selector => surfaceCss.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]+)\\}`, 'm'))?.[1] || '';
  assert.match(rule('.egd-first-run-desk'), /display: none/);
  const shown = rule(':root.egd-initial-browser-focus .egd-browser-card.egd-card-fullscreen .egd-first-run-desk');
  assert.match(shown, /display: inline-flex/);
  assert.match(shown, /background: var\(--egd-primary-container\)/);
  assert.match(shown, /color: var\(--egd-on-surface\)/);
  assert.match(rule('.egd-first-run-desk:hover'), /background: var\(--egd-/);
  assert.match(rule('.egd-first-run-desk:active'), /background: var\(--egd-/);
  assert.match(rule('.egd-first-run-desk:focus-visible'), /outline: var\(--egd-focus-outline\)/);
  const line = rule('#egd-first-entry-notice');
  assert.match(line, /position: fixed/);
  assert.match(line, /top: 60px/);
  assert.match(line, /background: var\(--egd-surface-elevated\)/);
  assert.match(line, /color: var\(--egd-on-surface\)/);
  assert.match(surfaceCss, /:root\.egd-initial-browser-focus #egd-first-entry-notice,\n:root\.egd-card-fullscreen-active #egd-first-entry-notice,\n:root\.egd-browser-fullscreen-active #egd-first-entry-notice \{ display: none; \}/);
  assert.match(rule('.egd-first-entry-action:focus-visible, .egd-first-entry-close:focus-visible'), /outline: var\(--egd-focus-outline\)/);
  const mine = surfaceCss.match(/\/\* First run: the labelled Desk button[\s\S]*?\/\* end first run \*\//)?.[0] || '';
  assert.ok(mine, 'first-run CSS block');
  assert.doesNotMatch(mine, /#[0-9A-Fa-f]{3,8}\b|rgba?\(/, 'tokens only');
});

test('once the Desk is open, other root class changes no longer read the Browser pages', () => {
  const h = harness();
  h.install();
  h.state.surface.initialBrowserFocus = false; h.rootClasses.delete('egd-initial-browser-focus');
  h.observed().fn();
  let reads = 0;
  const browser = h.card._xulBrowser;
  Object.defineProperty(h.card, '_xulBrowser', { get() { reads++; return browser; } });
  h.rootClasses.add('egd-card-fullscreen-active');
  h.observed().fn();
  h.rootClasses.delete('egd-card-fullscreen-active');
  h.observed().fn();
  assert.equal(reads, 0, 'first run follows its own class only');
});

test('the first Browser fills the screen without a selection edge around it', () => {
  const selected = ':root.egd-initial-browser-focus .egd-browser-card.egd-card-fullscreen:is(.egd-entity-active, .egd-entity-selected)';
  const rule = selector => surfaceCss.match(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]+)\\}`, 'm'))?.[1] || '';
  assert.match(rule(selected), /outline: 0/);
  assert.match(rule(`${selected}::after`), /display: none/);
  // The general focused-Browser rule (selection painted inward) stays for every other fullscreen Browser.
  assert.match(surfaceCss, /^\.egd-browser-card\.egd-card-fullscreen:is\(\.egd-entity-active, \.egd-entity-selected\)::after \{\n  content: "";/m);
});
