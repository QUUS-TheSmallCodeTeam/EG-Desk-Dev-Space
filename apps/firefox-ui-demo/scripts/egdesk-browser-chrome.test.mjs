import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  BROWSER_LOADING_LABEL, browserAddressFieldState, browserNavButtonState, browserSecurityIconName, browserSecurityKind,
  browserSecurityLabel, browserShortcutIntent, browserStatusText,
} from '../overlay/resources/EGDeskBrowserChrome.sys.mjs';

const surfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const surfaceCss = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');

test('Browser status separates the security kind from the Korean text it shows', () => {
  assert.equal(browserSecurityKind('https://example.test/path'), 'secure');
  assert.equal(browserSecurityKind('http://example.test/'), 'insecure');
  assert.equal(browserSecurityKind('file:///Users/me/a.txt'), 'local');
  assert.equal(browserSecurityKind('about:blank'), 'internal');
  assert.equal(browserSecurityKind('chrome://userchrome/content/egdesk-start.html'), 'site');
  assert.equal(browserSecurityKind('not a url'), 'site');
  assert.equal(browserSecurityKind(''), 'site');

  assert.equal(browserSecurityLabel('secure'), '보안 연결');
  assert.equal(browserSecurityLabel('insecure'), '보안되지 않음');
  assert.equal(browserSecurityLabel('local'), '이 PC');
  assert.equal(browserSecurityLabel('internal'), 'Firefox');
  assert.equal(browserSecurityLabel('site'), '사이트');
  assert.equal(browserSecurityLabel('unknown-kind'), '사이트');

  assert.equal(BROWSER_LOADING_LABEL, '불러오는 중');
  assert.equal(browserStatusText({ loading: true, security: 'secure' }), '불러오는 중');
  assert.equal(browserStatusText({ loading: false, security: 'secure' }), '보안 연결');
  assert.equal(browserStatusText({ loading: false, security: 'insecure' }), '보안되지 않음');
  assert.equal(browserStatusText({}), '사이트');

  assert.equal(browserSecurityIconName('secure'), 'lock');
  assert.equal(browserSecurityIconName('insecure'), 'alert');
  assert.equal(browserSecurityIconName('local'), 'file');
  assert.equal(browserSecurityIconName('internal'), 'browser');
  assert.equal(browserSecurityIconName('site'), 'browser');

  for (const kind of ['secure', 'insecure', 'local', 'site']) {
    assert.doesNotMatch(browserSecurityLabel(kind), /[A-Za-z]{3,}/, `${kind} label is Korean`);
  }
});

test('Browser toolbar buttons always have a name and say why they are off', () => {
  const idle = { canGoBack: false, canGoForward: false, loading: false };
  assert.deepEqual(browserNavButtonState('back', idle), { label: '뒤로', title: '뒤로 갈 페이지 없음', disabled: true });
  assert.deepEqual(browserNavButtonState('forward', idle), { label: '앞으로', title: '앞으로 갈 페이지 없음', disabled: true });
  assert.deepEqual(browserNavButtonState('back', { ...idle, canGoBack: true }), { label: '뒤로', title: '뒤로', disabled: false });
  assert.deepEqual(browserNavButtonState('forward', { ...idle, canGoForward: true }), { label: '앞으로', title: '앞으로', disabled: false });
  assert.deepEqual(browserNavButtonState('reload', idle), { label: '새로고침', title: '새로고침', disabled: false });
  assert.deepEqual(browserNavButtonState('reload', { ...idle, loading: true }), { label: '중지', title: '중지', disabled: false });
  assert.deepEqual(browserNavButtonState('home', idle), { label: '홈', title: '홈', disabled: false });
  assert.deepEqual(browserNavButtonState('duplicate', idle), { label: '복제', title: '복제', disabled: false });
  assert.deepEqual(browserNavButtonState('menu', idle), { label: '더보기', title: '더보기', disabled: false });
  assert.equal(browserNavButtonState('nope', idle), null);
});

test('Browser shortcuts fire only for the accelerator while a Browser window holds the focus', () => {
  const key = (letter, extra = {}) => ({ key: letter, code: `Key${letter.toUpperCase()}`, metaKey: false, ctrlKey: false,
    shiftKey: false, altKey: false, isComposing: false, keyCode: letter.toUpperCase().charCodeAt(0), repeat: false, ...extra });
  const mac = { isMac: true, activeIsBrowser: true, focusInActiveBrowser: true };
  const pc = { ...mac, isMac: false };

  assert.equal(browserShortcutIntent(key('l', { metaKey: true }), mac), 'focus-address');
  assert.equal(browserShortcutIntent(key('t', { metaKey: true }), mac), 'new-browser');
  assert.equal(browserShortcutIntent(key('l', { ctrlKey: true }), pc), 'focus-address');
  assert.equal(browserShortcutIntent(key('t', { ctrlKey: true }), pc), 'new-browser');
  // Korean IME layouts report another key value; the physical key still counts.
  assert.equal(browserShortcutIntent({ ...key('l', { metaKey: true }), key: 'ㅣ' }, mac), 'focus-address');
  assert.equal(browserShortcutIntent({ ...key('t', { metaKey: true }), key: 'ㅅ' }, mac), 'new-browser');

  // The other platform's modifier, extra modifiers, IME composition and key repeat are left alone.
  assert.equal(browserShortcutIntent(key('l', { ctrlKey: true }), mac), null);
  assert.equal(browserShortcutIntent(key('l', { metaKey: true }), pc), null);
  assert.equal(browserShortcutIntent(key('l', { metaKey: true, ctrlKey: true }), mac), null);
  assert.equal(browserShortcutIntent(key('l', { metaKey: true, shiftKey: true }), mac), null);
  assert.equal(browserShortcutIntent(key('t', { metaKey: true, altKey: true }), mac), null);
  assert.equal(browserShortcutIntent(key('t', { metaKey: true, isComposing: true }), mac), null);
  assert.equal(browserShortcutIntent(key('t', { metaKey: true, keyCode: 229 }), mac), null);
  assert.equal(browserShortcutIntent(key('t', { metaKey: true, repeat: true }), mac), null);
  assert.equal(browserShortcutIntent(key('k', { metaKey: true }), mac), null);
  assert.equal(browserShortcutIntent(key('l'), mac), null);

  // Another window (or the Chat, search, a terminal) holding the focus keeps its own keys.
  assert.equal(browserShortcutIntent(key('l', { metaKey: true }), { ...mac, activeIsBrowser: false }), null);
  assert.equal(browserShortcutIntent(key('t', { metaKey: true }), { ...mac, focusInActiveBrowser: false }), null);
  assert.equal(browserShortcutIntent(key('t', { metaKey: true }), { ...mac, canOpenWindow: false }), null);
  assert.equal(browserShortcutIntent(key('l', { metaKey: true }), { ...mac, canOpenWindow: false }), 'focus-address');
  assert.equal(browserShortcutIntent(key('l', { metaKey: true }), undefined), null);
  assert.equal(browserShortcutIntent(null, mac), null);
});

test('Browser window wires the toolbar pattern, names every icon button and installs the shortcuts', () => {
  const spawn = surfaceSource.match(/  function spawnBrowserCard\(initialUrl[\s\S]*?\n  \}\n/)?.[0] || '';
  assert.ok(spawn, 'spawnBrowserCard body');
  assert.doesNotMatch(spawn, /'Loading'|'Secure'|'Not secure'/);
  // Every icon button states its type and gets its name from the shared view model.
  for (const action of ['back', 'forward', 'reload', 'home', 'duplicate', 'menu']) {
    assert.match(spawn, new RegExp(`browserToolbarButton\\('${action}'`), `${action} uses the named toolbar button`);
  }
  const factory = spawn.match(/const browserToolbarButton = \(action, attrs, icon\) => \{([\s\S]*?)\n    \};/)?.[1] || '';
  assert.match(factory, /type: 'button'/);
  assert.match(factory, /applyBrowserToolbarButton\(button, action\)/);
  // One Tab stop, arrows inside; a turned-off Back keeps the focus (aria-disabled, not disabled).
  assert.match(spawn, /BrowserToolbarFocus\.bindToolbar\(deskWindow\.slots\.toolbar, \{ label: 'Browser 도구',\n\s+items: root => root\.querySelectorAll\('\.egd-card-nav-btn, \.egd-card-url, \.egd-card-menu'\) \}\)/);
  assert.doesNotMatch(spawn, /backButton\.disabled =|forwardButton\.disabled =/);
  assert.doesNotMatch(spawn, /el\('button', \{\s*class: 'egd-card-(?:nav-btn|menu)/, 'no toolbar button bypasses the named factory');

  // The name / tooltip / off state really land on the element, and follow the page state.
  const applyBody = spawn.match(/const applyBrowserToolbarButton = \(button, action\) => \{([\s\S]*?)\n    \};/)?.[1];
  assert.ok(applyBody, 'applyBrowserToolbarButton body');
  const browserState = { canGoBack: false, canGoForward: false, loading: false };
  const setItemDisabled = (el, disabled) => {
    if (disabled) el.attrs['aria-disabled'] = 'true'; else delete el.attrs['aria-disabled'];
    el.disabled = false;
  };
  const apply = new Function('BrowserChrome', 'BrowserToolbarFocus', 'browserState',
    `return (button, action) => {${applyBody}\n    };`)({ browserNavButtonState }, { setItemDisabled }, browserState);
  const back = { title: '', disabled: true, attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  apply(back, 'back');
  assert.deepEqual([back.title, back.attrs['aria-label'], back.attrs['aria-disabled'], back.disabled],
    ['뒤로 갈 페이지 없음', '뒤로', 'true', false]);
  browserState.canGoBack = true;
  apply(back, 'back');
  assert.deepEqual([back.title, back.attrs['aria-label'], back.attrs['aria-disabled']], ['뒤로', '뒤로', undefined]);
  const reload = { title: '', attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  browserState.loading = true;
  apply(reload, 'reload');
  assert.deepEqual([reload.title, reload.attrs['aria-label']], ['중지', '중지']);
  assert.match(spawn, /focusAddress: focusBrowserAddress/);

  const shortcut = surfaceSource.match(/  function installBrowserShortcuts\(\) \{([\s\S]*?)\n  \}\n/)?.[1] || '';
  assert.ok(shortcut, 'installBrowserShortcuts body');
  assert.match(shortcut, /BrowserChrome\.browserShortcutIntent\(/);
  assert.match(shortcut, /ev\.preventDefault\(\);\s*ev\.stopImmediatePropagation\(\);/);
  assert.match(surfaceSource, /\n      installBrowserShortcuts\(\);/);
});

test('Browser address field says which key reaches it, and the bar and its menu have different names', () => {
  assert.deepEqual(browserAddressFieldState({ isMac: true }),
    { label: '주소 또는 검색어', title: '주소 또는 검색어 (⌘L)', ariaKeyShortcuts: 'Meta+L' });
  assert.deepEqual(browserAddressFieldState({ isMac: false }),
    { label: '주소 또는 검색어', title: '주소 또는 검색어 (Ctrl+L)', ariaKeyShortcuts: 'Control+L' });
  assert.deepEqual(browserAddressFieldState(), browserAddressFieldState({ isMac: false }));

  const spawn = surfaceSource.match(/  function spawnBrowserCard\(initialUrl[\s\S]*?\n  \}\n/)?.[0] || '';
  const applyBody = spawn.match(/const applyBrowserAddressField = \(\) => \{([\s\S]*?)\n    \};\n    applyBrowserAddressField\(\);/)?.[1];
  assert.ok(applyBody, 'applyBrowserAddressField body, applied once when the bar is built');
  const urlInput = { title: '', attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } };
  const run = os => new Function('BrowserChrome', 'servicesRef', 'urlInput', applyBody)(
    { browserAddressFieldState }, () => ({ appinfo: { OS: os } }), urlInput);
  run('Darwin');
  assert.deepEqual([urlInput.title, urlInput.attrs['aria-label'], urlInput.attrs['aria-keyshortcuts']],
    ['주소 또는 검색어 (⌘L)', '주소 또는 검색어', 'Meta+L']);
  run('WINNT');
  assert.deepEqual([urlInput.title, urlInput.attrs['aria-keyshortcuts']], ['주소 또는 검색어 (Ctrl+L)', 'Control+L']);

  // A screen reader hears two different things: the bar and the menu its last button opens.
  assert.match(spawn, /role: 'menu',\n\s+'aria-label': 'Browser 더보기',/);
  assert.equal(spawn.split("'Browser 도구'").length - 1, 1, 'only the toolbar is named Browser 도구');
});

test('Browser shortcut handler leaves the key alone unless the view model claims it', () => {
  const body = surfaceSource.match(/  function installBrowserShortcuts\(\) \{([\s\S]*?)\n  \}\n/)?.[1];
  assert.ok(body);
  const listeners = [];
  const browserCard = { id: 'b1', isConnected: true, hidden: false,
    classList: { contains: name => name === 'egd-browser-card' }, contains: node => node === browserCard || node?.inside === true };
  const state = { activeEntityId: 'b1' };
  const document = { activeElement: { inside: true }, body: {}, documentElement: {},
    getElementById: id => (id === 'b1' ? browserCard : null) };
  const calls = [];
  const spawned = { id: 'b2' };
  const install = new Function('BrowserChrome', 'servicesRef', 'window', 'document', 'state', 'browserCardControl',
    'spawnBrowserCard', 'EGDESK_START_URI', `${body}`);
  install({ browserShortcutIntent }, () => ({ appinfo: { OS: 'Darwin' } }),
    { addEventListener: (type, fn, capture) => listeners.push({ type, fn, capture }) }, document, state,
    (card, command) => { calls.push([card.id, command]); return true; },
    (uri, options) => { calls.push(['spawn', uri, options.openMode]); return spawned; }, 'start:uri');
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].type, 'keydown');
  assert.equal(listeners[0].capture, true);
  const press = (letter, extra = {}) => {
    const ev = { key: letter, code: `Key${letter.toUpperCase()}`, metaKey: true, ctrlKey: false, shiftKey: false, altKey: false,
      isComposing: false, keyCode: 0, repeat: false, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...extra };
    listeners[0].fn(ev);
    return ev;
  };

  let ev = press('l');
  assert.deepEqual(calls, [['b1', 'focusAddress']]);
  assert.equal(ev.prevented && ev.stopped, true);

  calls.length = 0;
  ev = press('t');
  assert.deepEqual(calls, [['spawn', 'start:uri', 'new'], ['b2', 'focusAddress']]);
  assert.equal(ev.prevented && ev.stopped, true);

  // A maximized window covers the Desk: no unseen window opens, the address shortcut still works.
  calls.length = 0;
  state.cardFullscreen = { cardId: 'b1' };
  ev = press('t');
  assert.deepEqual(calls, []);
  assert.equal(ev.prevented || ev.stopped, false);
  ev = press('l');
  assert.deepEqual(calls, [['b1', 'focusAddress']]);
  state.cardFullscreen = null;

  // Focus in the Chat (outside the active Browser window): Firefox keeps the key.
  calls.length = 0;
  document.activeElement = { inside: false };
  ev = press('l');
  assert.deepEqual(calls, []);
  assert.equal(ev.prevented || ev.stopped, false);

  // No focused control at all still counts as the active Browser window.
  document.activeElement = document.body;
  ev = press('l');
  assert.deepEqual(calls, [['b1', 'focusAddress']]);

  // Another kind of window is active.
  calls.length = 0;
  state.activeEntityId = 'chat-1';
  ev = press('t');
  assert.deepEqual(calls, []);
  assert.equal(ev.prevented || ev.stopped, false);
});

test('Browser address field follows the approved shape and nav buttons keep a 32px press area', () => {
  const declarations = selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const body = surfaceCss.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]+)\\}`))?.[1] || '';
    return Object.fromEntries(body.split(';').map(line => line.split(':').map(part => part.trim())).filter(pair => pair.length === 2 && pair[0]));
  };
  const address = declarations('.egd-browser-card .egd-card-omnibox');
  assert.equal(address.height, '25px');
  assert.equal(address['border-radius'], '5px');
  assert.equal(address['border-color'], 'var(--egd-outline-variant)');
  assert.equal(address.background, 'var(--egd-window-alt)');
  assert.equal(declarations('.egd-browser-card[data-egd-browser-presentation] .egd-card-omnibox').height,
    'calc(25px * var(--egd-browser-ui-scale))');
  assert.equal(declarations('.egd-browser-card[data-egd-browser-presentation] .egd-card-omnibox')['border-radius'],
    'calc(5px * var(--egd-browser-ui-scale))');
  // The buttons keep their look; the whole 32px button (the full row height) is the press area.
  const pressArea = declarations('.egd-browser-card[data-egd-browser-presentation] .egd-desk-window-control,\n'
    + '.egd-browser-card[data-egd-browser-presentation] .egd-card-nav-btn,\n'
    + '.egd-browser-card[data-egd-browser-presentation] .egd-card-menu');
  assert.equal(pressArea.width, 'calc(32px * var(--egd-browser-ui-scale))');
  assert.equal(pressArea.height, 'calc(32px * var(--egd-browser-ui-scale))');
  // A turned-off button that keeps the focus looks and behaves turned off.
  const off = declarations('.egd-card-nav-btn[aria-disabled="true"]');
  assert.equal(off.opacity, 'var(--egd-opacity-disabled)');
  assert.equal(off.cursor, 'default');
  const offHover = declarations('.egd-card-nav-btn[aria-disabled="true"]:hover,\n.egd-card-nav-btn[aria-disabled="true"]:active');
  assert.equal(offHover.background, 'transparent');
});
