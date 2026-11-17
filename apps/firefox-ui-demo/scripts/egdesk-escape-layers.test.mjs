// UX-06 screen wiring: the installEscapeLayers block of the surface file,
// compiled on its own with a small stand-in for the screen.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as EscapeLayerStack from '../overlay/resources/EGDeskLayerStack.sys.mjs';
import * as AccountMenuFocus from '../overlay/resources/EGDeskFocusNavigation.sys.mjs';
import * as SurfaceKeys from '../overlay/resources/surface/EGDeskSurfaceKeys.mjs';

const surfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const CHAT_MENU_OPENER = '.egd-codex-thread-menu-trigger-active, .egd-codex-message-menu-trigger-active, '
  + '.egd-codex-engine-chip[aria-expanded="true"], .egd-codex-agent-peek-trigger[aria-expanded="true"], .egd-codex-thread-member-menu-open';

function mountEscapeLayers() {
  const start = surfaceSource.indexOf('  function installEscapeLayers() {');
  const end = surfaceSource.indexOf('\n  installEscapeLayers();', start);
  assert.ok(start > 0 && end > start, 'installEscapeLayers block is present');
  const log = [];
  const listeners = [];
  const window = { addEventListener: (type, handler, capture = false) => listeners.push({ type, handler, capture: capture === true }) };
  const selectors = new Map();
  const ids = new Map();
  const document = {
    activeElement: null,
    getElementById: id => ids.get(id) || null,
    querySelector: selector => { const hit = selectors.get(selector); return (typeof hit === 'function' ? hit() : hit) || null; },
    querySelectorAll: () => [],
  };
  const node = (localName = 'div', inside = []) => {
    const self = {
      localName, ownerDocument: document, isConnected: true, dataset: {}, isContentEditable: false,
      classList: { hidden: false, contains(name) { return name === 'egd-hud-hidden' && this.hidden; } },
      closest: selector => inside.includes(selector) ? self : null,
      focus() { document.activeElement = self; log.push(`focus:${self.name || localName}`); },
      querySelector: () => null,
    };
    return self;
  };
  const state = {
    cardFullscreen: null, surface: { initialBrowserFocus: false }, railSearch: { open: false }, agenda: { switcherOpen: false },
    codex: { threadMenu: null, memberMenu: null, engineMenu: null, messageMenu: null, agentPeek: null },
    codexBridge: {
      closeMemberMenu() { state.codex.memberMenu = null; },
      closeThreadMenu() { if (state.codex.threadMenu) log.push('close:thread-menu'); state.codex.threadMenu = null; },
      closeEngineMenu() { if (state.codex.engineMenu) log.push('close:engine-menu'); state.codex.engineMenu = null; },
      closeMessageMenu() { state.codex.messageMenu = null; },
      closeAgentPeek() { state.codex.agentPeek = null; },
    },
  };
  const escapeLayers = EscapeLayerStack.createLayerStack({ rank: EscapeLayerStack.escapeRank });
  const registerEscapeLayer = (layer) => { const id = escapeLayers.push(layer); return () => escapeLayers.remove(id); };
  const closers = {};
  const closer = name => (...args) => { log.push(`close:${name}`); return closers[name]?.(...args); };
  const names = ['window', 'document', 'state', 'EscapeLayerStack', 'escapeLayers', 'registerEscapeLayer', 'boardRegionMenu', 'deskMenu',
    'closeBoardRegionMenu', 'closeDeskMenu', 'closeMinimapStack', 'closeAgendaCloseGuard', 'closeRailSearchPanel', 'closeAgendaSwitcher',
    'closeBoardHistoryPanel', 'closeDeskHistoryPanel', 'closeDeskMinimap', 'setHudPresentationHidden', 'exitCardFullscreen',
    'SurfaceKeys', 'closeMaximizeHudPeek', 'memoRelink'];
  const relink = { current: null };
  const install = new Function(...names, `${surfaceSource.slice(start, end)}\n  return installEscapeLayers;`)(
    window, document, state, EscapeLayerStack, escapeLayers, registerEscapeLayer, null, null,
    closer('board-menu'), closer('desk-menu'), closer('minimap-stack'), closer('close-guard'), closer('rail-search'), closer('board-switcher'),
    closer('board-history'), closer('desk-history'), closer('minimap'), closer('hud-hidden'), closer('fullscreen'),
    SurfaceKeys, closer('chat-peek'), null);
  install();
  const fire = (type, capture, event) => { for (const entry of listeners) if (entry.type === type && entry.capture === capture) entry.handler(event); };
  // One key press travels capture → the focused element's own handler → bubble.
  const press = (target, { own = null, ...extra } = {}) => {
    const event = {
      key: 'Escape', target, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra,
    };
    fire('keydown', true, event);
    if (!event.stopped) own?.(event);
    if (!event.stopped) fire('keydown', false, event);
    return event;
  };
  return { log, state, document, ids, selectors, node, closers, escapeLayers, listeners, press, fire, relink };
}

test('the surface registers every Escape layer through one channel and listens in one place', () => {
  const { escapeLayers, listeners } = mountEscapeLayers();
  for (const id of ['chat-menu', 'settings-account-menu', 'board-menu', 'desk-menu', 'minimap-stack', 'board-close-guard',
    'minimap', 'desk-history', 'board-history', 'board-switcher', 'rail-search', 'chat-peek', 'focus-view', 'view-fullscreen', 'memo-relink']) {
    assert.equal(escapeLayers.has(id), true, id);
  }
  assert.equal(escapeLayers.size(), 0);
  assert.deepEqual(listeners.map(entry => `${entry.type}:${entry.capture ? 'capture' : 'bubble'}`),
    ['keydown:capture', 'keydown:bubble', 'mousedown:capture']);
  // The screen file has exactly one screen-wide Escape block, installed once.
  assert.equal(surfaceSource.split('EscapeLayerStack.escapeRoute(').length - 1, 1);
  assert.equal(surfaceSource.split("ChromeUtils.importESModule('chrome://userchrome/content/EGDeskLayerStack.sys.mjs')").length - 1, 1);
  assert.equal(surfaceSource.split('\n  installEscapeLayers();\n').length - 1, 1);
  assert.match(surfaceSource, /\n  function registerEscapeLayer\(layer\) \{\n    const id = escapeLayers\.push\(layer\);/);
  // The right-click placement menu and its number dialog register where they live.
  assert.match(surfaceSource, /registerEscapeLayer\(\{ id: 'placement-menu', kind: 'menu', isOpen: \(\) => !!placementMenu,/);
  assert.match(surfaceSource, /registerEscapeLayer\(\{ id: 'placement-dialog', kind: 'dialog', isOpen: \(\) => !!placementDialog,/);
});

test('Escape closes one thing per press: menu, confirmation, search, minimap, peeked Chat, then the fullscreen View', () => {
  const { log, state, document, ids, selectors, node, closers, press } = mountEscapeLayers();
  const hud = node('div');
  ids.set('egd-hud', hud);
  ids.set('egd-desk-minimap', node('section'));
  ids.set('egd-agenda-close-guard', node('div'));
  state.cardFullscreen = { cardId: 'card-1', mode: 'maximized', hudMode: 'peek' };
  state.railSearch.open = true;
  state.codex.threadMenu = { threadId: 't1' };
  const opener = node('button');
  opener.name = 'thread-menu-opener';
  selectors.set(CHAT_MENU_OPENER, () => opener);
  closers['close-guard'] = () => ids.delete('egd-agenda-close-guard');
  closers['rail-search'] = () => { state.railSearch.open = false; };
  closers.minimap = () => ids.delete('egd-desk-minimap');
  closers['chat-peek'] = () => { state.cardFullscreen.hudMode = 'hidden'; hud.classList.hidden = true; return true; };
  closers.fullscreen = () => { state.cardFullscreen = null; return true; };
  const canvas = node('div');

  const steps = [];
  for (let i = 0; i < 6; i += 1) {
    const before = log.length;
    const event = press(canvas);
    assert.equal(event.defaultPrevented, true, `press ${i + 1} is used`);
    steps.push(log.slice(before).join(' '));
  }
  assert.deepEqual(steps, [
    'focus:thread-menu-opener close:thread-menu',
    'close:close-guard',
    'close:rail-search',
    'close:minimap',
    'close:chat-peek',
    'close:fullscreen',
  ]);
  assert.equal(document.activeElement, opener);
  assert.equal(state.codex.threadMenu, null);
  // Nothing is open: Escape is left to whoever else wants it.
  const idle = press(canvas);
  assert.equal(idle.defaultPrevented, false);
  assert.equal(log.length, 7);
});

test('each Chat menu closes on Escape and the Chat window stays', () => {
  const { log, state, node, press } = mountEscapeLayers();
  const canvas = node('div');
  for (const key of ['threadMenu', 'memberMenu', 'engineMenu', 'messageMenu', 'agentPeek']) {
    state.codex[key] = { threadId: 't1' };
    const event = press(canvas);
    assert.equal(event.defaultPrevented, true, key);
    assert.equal(event.stopped, true, key);
    assert.equal(state.codex[key], null, key);
    assert.equal(press(canvas).defaultPrevented, false, `${key}: the next Escape has nothing to close`);
  }
  assert.deepEqual(log, ['close:thread-menu', 'close:engine-menu']);
  // Focus inside the Agent profile: its own Escape (close and return focus) runs, once.
  state.codex.agentPeek = { messageId: 'm1' };
  let own = 0;
  const inPeek = node('button', ['.egd-codex-agent-peek']);
  press(inPeek, { own: (event) => { own += 1; state.codex.agentPeek = null; event.preventDefault(); event.stopPropagation(); } });
  assert.equal(own, 1);
  assert.equal(state.codex.agentPeek, null);
});

test('typing in the composer keeps focus when Escape closes a Chat menu; a focused popover closes before the minimap', () => {
  const { log, state, document, ids, selectors, node, closers, press } = mountEscapeLayers();
  const opener = node('button');
  opener.name = 'thread-menu-opener';
  selectors.set(CHAT_MENU_OPENER, () => opener);
  const composer = node('textarea');
  document.activeElement = composer;
  state.codex.threadMenu = { threadId: 't1' };
  const typed = press(composer);
  assert.equal(typed.defaultPrevented, true);
  assert.equal(state.codex.threadMenu, null);
  assert.equal(document.activeElement, composer);
  assert.deepEqual(log, ['close:thread-menu']);

  // The minimap can stay open for a long time. A popover that has focus and
  // handles its own Escape closes first; the minimap closes on the next press.
  ids.set('egd-desk-minimap', node('section'));
  closers.minimap = () => ids.delete('egd-desk-minimap');
  let popoverOpen = true;
  const popoverItem = node('button');
  press(popoverItem, { own: (event) => { popoverOpen = false; event.preventDefault(); event.stopPropagation(); } });
  assert.equal(popoverOpen, false);
  assert.ok(ids.get('egd-desk-minimap'));
  press(node('div'));
  assert.equal(ids.has('egd-desk-minimap'), false);
  assert.deepEqual(log, ['close:thread-menu', 'close:minimap']);
});

test('a fullscreen View waits for the focused element; a page or terminal keeps its Escape; Korean composing is ignored', () => {
  const { log, state, document, node, closers, press, fire } = mountEscapeLayers();
  closers.fullscreen = () => { state.cardFullscreen = null; return true; };
  const enter = () => { state.cardFullscreen = { cardId: 'card-1' }; };
  const canvas = node('div');

  enter();
  // Capture alone never shrinks the View.
  const captureOnly = { key: 'Escape', target: canvas, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() {} };
  fire('keydown', true, captureOnly);
  assert.equal(captureOnly.defaultPrevented, false);
  // A panel that handles its own Escape wins.
  press(canvas, { own: event => event.preventDefault() });
  assert.deepEqual(log, []);
  // A page, a terminal frame, the <browser> element.
  press({ localName: 'textarea', ownerDocument: { other: true }, isConnected: true, closest: () => null });
  press(node('browser'));
  press(node('iframe'));
  // Korean IME composing, and a held key.
  press(canvas, { isComposing: true });
  press(canvas, { keyCode: 229 });
  press(canvas, { repeat: true });
  assert.deepEqual(log, []);
  assert.ok(state.cardFullscreen);

  // A field that cancelled its own edit (it lost focus or left the screen) used the key.
  const rename = node('input');
  document.activeElement = rename;
  press(rename, { own: () => { document.activeElement = canvas; } });
  const gone = node('input');
  document.activeElement = gone;
  press(gone, { own: () => { gone.isConnected = false; } });
  assert.deepEqual(log, []);
  // A field that did nothing with Escape lets the View shrink.
  const composer = node('textarea');
  document.activeElement = composer;
  press(composer);
  assert.deepEqual(log, ['close:fullscreen']);
  assert.equal(state.cardFullscreen, null);

  // The first-run Browser focus screen is not an Escape layer.
  enter();
  state.surface.initialBrowserFocus = true;
  assert.equal(press(canvas).defaultPrevented, false);
  assert.deepEqual(log, ['close:fullscreen']);
});

test('the Settings account menu closes on Escape with focus back on its button, and on a click outside it', () => {
  const { log, selectors, node, press, fire, state } = mountEscapeLayers();
  const summary = node('summary');
  summary.name = 'account-menu-button';
  const menu = { open: true, querySelector: selector => selector === 'summary' ? summary : null };
  selectors.set('.egd-settings-account-menu[open]', () => menu.open ? menu : null);
  const item = node('button', ['.egd-settings-account-menu']);
  const elsewhere = node('div');
  state.cardFullscreen = { cardId: 'settings' };

  // A click inside keeps it; a click elsewhere closes it and is not swallowed.
  fire('mousedown', true, { target: item });
  assert.equal(menu.open, true);
  const outside = { target: elsewhere, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
  fire('mousedown', true, outside);
  assert.equal(menu.open, false);
  assert.equal(outside.defaultPrevented, false);
  assert.deepEqual(log, []);

  // Escape from an item inside the menu: the menu closes, the View stays large.
  menu.open = true;
  const event = press(item);
  assert.equal(menu.open, false);
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(log, ['focus:account-menu-button']);
  assert.ok(state.cardFullscreen);
});

test('the Settings account menu opens from its button with Down or Up and moves between items with the arrow keys', () => {
  const start = surfaceSource.indexOf('  function handleAccountMenuKeydown(ev) {');
  const end = surfaceSource.indexOf('\n  }\n', start);
  assert.ok(start > 0 && end > start, 'handleAccountMenuKeydown is present');
  assert.equal(surfaceSource.split("window.addEventListener('keydown', handleAccountMenuKeydown);").length - 1, 1);
  const document = { activeElement: null };
  const handle = new Function('document', 'AccountMenuFocus', `${surfaceSource.slice(start, end + 4)}\n  return handleAccountMenuKeydown;`)(document, AccountMenuFocus);
  const item = (name, disabled = false) => {
    const self = { name, disabled, closest: selector => selector === '.egd-settings-account-menu' ? menu : null, focus() { document.activeElement = self; } };
    return self;
  };
  const items = [item('refresh'), item('switch', true), item('logout')];
  const menu = { open: false, querySelectorAll: selector => selector === '[role="menuitem"]' ? items : [] };
  const summary = item('button');
  const key = (target, name, extra = {}) => {
    const event = { key: name, target, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...extra };
    return { used: handle(event), event };
  };

  // Home and End on the closed button do nothing; Down opens and lands on the first item.
  document.activeElement = summary;
  assert.equal(key(summary, 'Home').used, false);
  assert.equal(menu.open, false);
  const opened = key(summary, 'ArrowDown');
  assert.equal(opened.used, true);
  assert.equal(opened.event.defaultPrevented, true);
  assert.equal(menu.open, true);
  assert.equal(document.activeElement.name, 'refresh');
  // A disabled item is skipped; the ends wrap around.
  key(items[0], 'ArrowDown');
  assert.equal(document.activeElement.name, 'logout');
  key(items[2], 'ArrowDown');
  assert.equal(document.activeElement.name, 'refresh');
  key(items[0], 'ArrowUp');
  assert.equal(document.activeElement.name, 'logout');
  key(items[2], 'Home');
  assert.equal(document.activeElement.name, 'refresh');
  key(items[0], 'End');
  assert.equal(document.activeElement.name, 'logout');
  // Up on the closed button opens on the last item.
  menu.open = false;
  document.activeElement = summary;
  key(summary, 'ArrowUp');
  assert.equal(menu.open, true);
  assert.equal(document.activeElement.name, 'logout');
  // Other keys, modified keys, Korean composing and keys outside the menu are left alone.
  for (const [target, name, extra] of [[items[2], 'Enter'], [items[2], 'ArrowRight'], [items[2], 'ArrowDown', { metaKey: true }],
    [items[2], 'ArrowDown', { isComposing: true }], [{ closest: () => null }, 'ArrowDown']]) {
    const result = key(target, name, extra);
    assert.equal(result.used, false, name);
    assert.equal(result.event.defaultPrevented, false, name);
  }
  assert.equal(document.activeElement.name, 'logout');
  // Every item disabled (an account action is running): the key is not used.
  for (const entry of items) entry.disabled = true;
  menu.open = false;
  assert.equal(key(summary, 'ArrowDown').used, false);
  assert.equal(menu.open, false);
});

test('UX-06 registry: the screen registers exactly the layers SurfaceKeys names, each with its tier', () => {
  const ids = [...surfaceSource.matchAll(/registerEscapeLayer\(\{\s*id: '([a-z-]+)', kind: '([a-z-]+)'/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(SurfaceKeys.escapeRegistryGaps(ids.map(([id]) => id)), { missing: [], unknown: [] });
  for (const [id, kind] of ids) assert.equal(SurfaceKeys.escapeLayerSpec(id).kind, kind, id);
  // The same tier order as the layer stack.
  assert.deepEqual(SurfaceKeys.ESCAPE_TIERS, [...EscapeLayerStack.ESCAPE_ORDER]);
  for (const layer of SurfaceKeys.ESCAPE_LAYER_REGISTRY) {
    assert.equal(EscapeLayerStack.escapeRank(layer.kind), SurfaceKeys.ESCAPE_TIERS.indexOf(SurfaceKeys.escapeTierOf(layer.kind)), layer.id);
  }
  // The maximize peek has no Escape listener of its own any more.
  assert.equal(surfaceSource.includes("if (closeMaximizeHudPeek()) ev.preventDefault();"), false);
});

test('UX-06: a pinned Chat is not closed by Escape; the View shrinks and the pinned Chat stays', () => {
  const { log, state, ids, node, closers, press } = mountEscapeLayers();
  ids.set('egd-hud', node('div'));
  state.cardFullscreen = { cardId: 'card-1', mode: 'maximized', hudMode: 'pinned' };
  closers.fullscreen = () => { state.cardFullscreen = null; return true; };
  press(node('div'));
  assert.deepEqual(log, ['close:fullscreen']);
});

test('UX-06: Escape ends 집중 보기, also from a focused page that left the key unused, never on the first-run focus screen', () => {
  const { log, state, ids, node, closers, press } = mountEscapeLayers();
  ids.set('egd-hud', node('div'));
  closers.fullscreen = () => { state.cardFullscreen = null; return true; };
  const enter = () => { state.cardFullscreen = { cardId: 'card-1', mode: 'focus', hudMode: 'hidden' }; };
  enter();
  assert.equal(press(node('div')).defaultPrevented, true);
  assert.deepEqual(log, ['close:fullscreen']);
  // A page (the <browser>) had the key first and used it: the focus view stays.
  enter();
  press(node('browser'), { own: event => event.preventDefault() });
  assert.ok(state.cardFullscreen);
  // The page left it unused: Escape ends the focus view.
  const event = press(node('browser'));
  assert.equal(event.defaultPrevented, true);
  assert.equal(state.cardFullscreen, null);
  // A maximized (not focus) View keeps the page's Escape as before.
  state.cardFullscreen = { cardId: 'card-1', mode: 'maximized', hudMode: 'hidden' };
  press(node('browser'));
  assert.ok(state.cardFullscreen);
  // Korean composing in a page, and the first-run Browser focus screen.
  enter();
  press(node('browser'), { isComposing: true });
  assert.ok(state.cardFullscreen);
  state.surface.initialBrowserFocus = true;
  press(node('browser'));
  press(node('div'));
  assert.ok(state.cardFullscreen);
  assert.deepEqual(log, ['close:fullscreen', 'close:fullscreen']);
});
