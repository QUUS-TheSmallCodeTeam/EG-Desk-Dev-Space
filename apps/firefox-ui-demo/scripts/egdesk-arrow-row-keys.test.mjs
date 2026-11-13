// A65 (BRW-01): Left/Right/Home/End move focus between the buttons of the Dock,
// the top bar and the Canvas view bar. The handler is cut out of the surface
// script and run against the real movement rules in EGDeskFocusNavigation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as FocusNavigation from '../overlay/resources/EGDeskFocusNavigation.sys.mjs';

const surfaceJs = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const from = surfaceJs.indexOf("  const ARROW_ROW_ROOTS = ");
const to = surfaceJs.indexOf('\n  function boot() {');
assert.ok(from > 0 && to > from, 'arrow row block sits right above boot');
const block = surfaceJs.slice(from, to);

const ROOTS = '#egd-dock, #egd-desk-rail, #egd-zoom-indicator';
const ITEMS = 'button, [role="button"]';

function harness() {
  const listeners = [];
  const window = {
    addEventListener: (type, handler, capture) => listeners.push([type, handler, capture]),
    removeEventListener: (type, handler) => { const at = listeners.findIndex(row => row[0] === type && row[1] === handler); if (at >= 0) listeners.splice(at, 1); },
  };
  const api = new Function('ArrowRowNavigation', 'window', `${block}\nreturn { handleArrowRowKeydown, installArrowRowKeys };`)(FocusNavigation, window);
  const focused = [];
  const root = { items: [], querySelectorAll(selector) { assert.equal(selector, ITEMS); return this.items; } };
  const button = (name, { disabled = false, hidden = false, popup = false, inRow = true, isButton = true } = {}) => {
    const node = { name, disabled, focus() { focused.push(name); },
      matches: selector => { assert.equal(selector, ITEMS); return isButton; },
      closest: selector => (selector === ROOTS ? (inRow ? root : null) : (popup ? {} : null)),
      getClientRects: () => (hidden ? [] : [{}]) };
    if (inRow) root.items.push(node);
    return node;
  };
  const press = (target, key, fields = {}) => {
    const event = { key, target, defaultPrevented: false, prevented: false, stopped: false,
      preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...fields };
    api.handleArrowRowKeydown(event);
    return event;
  };
  return { api, window, listeners, focused, root, button, press };
}

test('A65 the three bars are named and the listener is installed once at boot', () => {
  assert.ok(block.includes(`const ARROW_ROW_ROOTS = '${ROOTS}';`));
  assert.equal(surfaceJs.split('installArrowRowKeys();').length - 1, 1, 'boot installs it once');
  for (const id of ["id: 'egd-dock'", "id: 'egd-desk-rail'", "id: 'egd-zoom-indicator'"]) assert.ok(surfaceJs.includes(id), id);
  const h = harness();
  h.api.installArrowRowKeys(); h.api.installArrowRowKeys();
  assert.deepEqual(h.listeners.map(row => [row[0], row[2]]), [['keydown', undefined]], 'one bubble-phase listener, so a control that handles the key itself keeps it');
});

test('A65 Right and Left move one button, wrap at the ends, and skip disabled or hidden ones', () => {
  const h = harness();
  const a = h.button('chat'), b = h.button('file', { disabled: true }), c = h.button('hidden', { hidden: true }), d = h.button('browser');
  const moved = h.press(a, 'ArrowRight');
  assert.deepEqual(h.focused, ['browser']);
  assert.equal(moved.prevented && moved.stopped, true, 'the key is consumed only when focus moves');
  h.press(d, 'ArrowRight'); h.press(a, 'ArrowLeft');
  assert.deepEqual(h.focused, ['browser', 'chat', 'browser'], 'wraps both ways');
  assert.ok(b && c);
});

test('A65 Home and End jump to the first and last usable button', () => {
  const h = harness();
  h.button('first', { disabled: true }); const second = h.button('second'); h.button('third'); const last = h.button('last');
  h.press(last, 'Home'); h.press(second, 'End');
  assert.deepEqual(h.focused, ['second', 'last']);
});

test('A65 it leaves text fields, menus, other areas, modified keys and handled keys alone', () => {
  const h = harness();
  const a = h.button('a'); h.button('b');
  const untouched = [
    h.press(h.button('search-input', { isButton: false }), 'ArrowRight'),
    h.press(h.button('menu-item', { popup: true }), 'ArrowRight'),
    h.press(h.button('elsewhere', { inRow: false }), 'ArrowRight'),
    h.press(a, 'ArrowRight', { shiftKey: true }), h.press(a, 'ArrowRight', { metaKey: true }),
    h.press(a, 'ArrowRight', { ctrlKey: true }), h.press(a, 'ArrowRight', { altKey: true }),
    h.press(a, 'ArrowRight', { defaultPrevented: true }),
    h.press(a, 'ArrowDown'), h.press(a, 'Tab'), h.press(a, 'Enter'),
  ];
  assert.deepEqual(h.focused, []);
  assert.ok(untouched.every(event => !event.prevented && !event.stopped));
});

test('A65 a lone button keeps the key so nothing is swallowed', () => {
  const h = harness();
  const only = h.button('only');
  const event = h.press(only, 'ArrowRight');
  assert.deepEqual(h.focused, []);
  assert.equal(event.prevented, false);
});
