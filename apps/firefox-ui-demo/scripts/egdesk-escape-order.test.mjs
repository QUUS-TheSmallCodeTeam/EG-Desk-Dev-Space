// UX-06: which open layer one Escape closes, and when Escape is left alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ESCAPE_ORDER, createLayerStack, escapeRank, escapeRoute,
} from '../overlay/resources/EGDeskLayerStack.sys.mjs';

const escapeEvent = (extra = {}) => ({
  key: 'Escape', defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...extra,
});

test('Escape order is menu, confirm, panel, peek, fullscreen', () => {
  assert.deepEqual([...ESCAPE_ORDER], ['menu', 'confirm', 'panel', 'peek', 'fullscreen']);
  assert.ok(Object.isFrozen(ESCAPE_ORDER));
  assert.equal(escapeRank('menu'), 0);
  assert.equal(escapeRank('list'), 0);
  assert.equal(escapeRank('popover'), 0);
  assert.equal(escapeRank('confirm'), 1);
  assert.equal(escapeRank('dialog'), 1);
  assert.equal(escapeRank('search'), 2);
  assert.equal(escapeRank('minimap'), 2);
  assert.equal(escapeRank('briefing'), 2);
  assert.equal(escapeRank('peek'), 3);
  assert.equal(escapeRank('fullscreen'), 4);
  // An unknown kind is a panel: it closes before a peeked Chat or a fullscreen View.
  assert.equal(escapeRank('something-else'), 2);
  assert.equal(escapeRank(null), 2);
});

test('a ranked stack closes one layer per Escape in the product order, newest first inside a tier', () => {
  const closed = [];
  const stack = createLayerStack({ rank: escapeRank });
  const add = (id, kind) => stack.push({ id, kind, dismiss: () => { closed.push(id); } });
  add('menu-old', 'menu');
  add('fullscreen', 'fullscreen');
  add('search', 'search');
  add('confirm', 'confirm');
  add('peek', 'peek');
  add('menu-new', 'menu');
  add('minimap', 'minimap');
  assert.deepEqual(stack.top(), { id: 'menu-new', kind: 'menu' });
  for (let i = 0; i < 7; i += 1) assert.equal(stack.handleEscape(escapeEvent()).dismissed, true);
  assert.deepEqual(closed, ['menu-new', 'menu-old', 'confirm', 'minimap', 'search', 'peek', 'fullscreen']);
  assert.equal(stack.handleEscape(escapeEvent()).reason, 'empty');
  // Without a rank the stack stays newest-first.
  const plain = createLayerStack();
  plain.push({ id: 'fullscreen', kind: 'fullscreen' });
  plain.push({ id: 'menu', kind: 'menu' });
  plain.push({ id: 'peek', kind: 'peek' });
  assert.equal(plain.top().id, 'peek');
});

test('a standing layer counts only while its own state says it is open, and stays registered', () => {
  const open = { menu: false, fullscreen: true };
  const closed = [];
  const stack = createLayerStack({ rank: escapeRank });
  stack.push({ id: 'chat-menu', kind: 'menu', isOpen: () => open.menu, dismiss: () => { open.menu = false; closed.push('chat-menu'); } });
  stack.push({ id: 'fullscreen', kind: 'fullscreen', isOpen: () => open.fullscreen, dismiss: () => { open.fullscreen = false; closed.push('fullscreen'); } });
  assert.deepEqual(stack.list(), [{ id: 'fullscreen', kind: 'fullscreen' }]);
  assert.equal(stack.size(), 1);
  open.menu = true;
  assert.deepEqual(stack.top(), { id: 'chat-menu', kind: 'menu' });
  assert.equal(stack.handleEscape(escapeEvent()).id, 'chat-menu');
  assert.equal(stack.handleEscape(escapeEvent()).id, 'fullscreen');
  assert.equal(stack.handleEscape(escapeEvent()).reason, 'empty');
  assert.deepEqual(closed, ['chat-menu', 'fullscreen']);
  // Still registered: it opens again later and Escape closes it again.
  assert.equal(stack.has('chat-menu'), true);
  open.menu = true;
  assert.equal(stack.handleEscape(escapeEvent()).id, 'chat-menu');
  assert.equal(stack.pop(), null);
});

test('a standing layer that stays open or breaks cannot swallow every later Escape', () => {
  const stack = createLayerStack({ rank: escapeRank });
  let fullscreen = true;
  stack.push({ id: 'stuck', kind: 'menu', isOpen: () => true, dismiss: () => {} });
  stack.push({ id: 'broken', kind: 'menu', isOpen: () => { throw new Error('gone'); }, dismiss: () => {} });
  stack.push({ id: 'fullscreen', kind: 'fullscreen', isOpen: () => fullscreen, dismiss: () => { fullscreen = false; } });
  // A probe that throws is not open.
  assert.equal(stack.top().id, 'stuck');
  const first = stack.handleEscape(escapeEvent());
  assert.deepEqual([first.id, first.dismissed, first.reason], ['stuck', false, 'still-open']);
  // It did not close, so it is dropped and the next Escape reaches what is under it.
  assert.equal(stack.has('stuck'), false);
  assert.equal(stack.handleEscape(escapeEvent()).id, 'fullscreen');
  // A refusal (for example a confirmation is showing) keeps the layer.
  let refuse = true;
  stack.push({ id: 'guard', kind: 'confirm', isOpen: () => refuse, dismiss: () => false });
  assert.equal(stack.handleEscape(escapeEvent()).reason, 'refused');
  assert.equal(stack.has('guard'), true);
  refuse = false;
  assert.equal(stack.handleEscape(escapeEvent()).reason, 'empty');
});

test('pointer-down outside closes the layer Escape would close, and only when it asked for that', () => {
  const stack = createLayerStack({ rank: escapeRank });
  let menuOpen = true;
  const inside = { name: 'inside' };
  stack.push({ id: 'fullscreen', kind: 'fullscreen', isOpen: () => true, dismiss: () => {} });
  stack.push({
    id: 'account-menu', kind: 'menu', dismissOnPointerOutside: true,
    isOpen: () => menuOpen, contains: target => target === inside, dismiss: () => { menuOpen = false; },
  });
  assert.equal(stack.handlePointerDown({}, inside).reason, 'inside');
  assert.equal(menuOpen, true);
  const outside = stack.handlePointerDown({}, { name: 'outside' });
  assert.deepEqual([outside.id, outside.dismissed], ['account-menu', true]);
  assert.equal(stack.handlePointerDown({}, { name: 'outside' }).reason, 'not-dismissable');
});

test('escapeRoute leaves Escape alone while composing, inside a page or terminal, and after a field used it', () => {
  const route = input => escapeRoute({ key: 'Escape', phase: 'capture', zone: 'chrome', kind: 'menu', ...input });
  assert.deepEqual(route({ key: 'Enter' }), { act: false, reason: 'not-escape' });
  assert.deepEqual(route({ composing: true }), { act: false, reason: 'composing' });
  assert.deepEqual(route({ zone: 'content' }), { act: false, reason: 'content-owns-key' });
  assert.deepEqual(route({ zone: 'content', phase: 'bubble', kind: 'fullscreen' }), { act: false, reason: 'content-owns-key' });
  assert.deepEqual(route({ kind: null }), { act: false, reason: 'empty' });
  assert.deepEqual(route({ defaultPrevented: true }), { act: false, reason: 'already-handled' });
  // Menus, confirmations and panels close before anything else sees the key.
  assert.deepEqual(route({}), { act: true, reason: 'top-layer' });
  assert.deepEqual(route({ kind: 'confirm' }), { act: true, reason: 'top-layer' });
  assert.deepEqual(route({ kind: 'minimap' }), { act: true, reason: 'top-layer' });
  // A field (rename, search, composer) cancels its own edit first.
  assert.deepEqual(route({ zone: 'field' }), { act: false, reason: 'field-first' });
  assert.deepEqual(route({ zone: 'field', phase: 'bubble', fieldEnded: true }), { act: false, reason: 'field-used-key' });
  assert.deepEqual(route({ zone: 'field', phase: 'bubble', defaultPrevented: true }), { act: false, reason: 'already-handled' });
  assert.deepEqual(route({ zone: 'field', phase: 'bubble' }), { act: true, reason: 'top-layer' });
  // A peeked Chat and a fullscreen View wait for panels that own their Escape.
  assert.deepEqual(route({ kind: 'peek' }), { act: false, reason: 'base-waits' });
  assert.deepEqual(route({ kind: 'fullscreen' }), { act: false, reason: 'base-waits' });
  assert.deepEqual(route({ kind: 'fullscreen', phase: 'bubble' }), { act: true, reason: 'top-layer' });
  assert.deepEqual(route({ kind: 'fullscreen', phase: 'bubble', defaultPrevented: true }), { act: false, reason: 'already-handled' });
});
