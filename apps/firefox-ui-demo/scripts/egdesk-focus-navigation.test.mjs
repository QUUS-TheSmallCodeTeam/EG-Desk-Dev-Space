import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOLTIP_COOLDOWN_MS, TOOLTIP_DELAY_MS, bindRadioGroup, bindTabs, bindToolbar, bindTooltipTriggers,
  compositeKeyIntent, createTooltipController, entryFocusIndex, focusSnapshot, nextCompositeIndex,
  restoreFocus, setItemDisabled, textInputKeepsKey, tooltipContent,
} from '../overlay/resources/EGDeskFocusNavigation.sys.mjs';

// ------------------------------------------------------------ tiny DOM fake
// Just enough of the DOM for the binders: attributes, tree, selector subset
// (tag, [attr], [attr="v"], comma lists), capture/bubble dispatch, focus.

class FakeEvent {
  constructor(type, init = {}) {
    Object.assign(this, { bubbles: true, key: '', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false }, init);
    this.type = type;
    this.defaultPrevented = false;
    this.stopped = false;
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
}

function matchSimple(node, selector) {
  const m = /^([a-z]+)?((?:\[[^\]]+\])*)$/i.exec(selector);
  if (!m) throw new Error(`fake DOM cannot match ${selector}`);
  if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
  for (const attr of m[2].matchAll(/\[([^\]=]+)(?:="([^"]*)")?\]/g)) {
    if (!node.hasAttribute(attr[1])) return false;
    if (attr[2] !== undefined && node.getAttribute(attr[1]) !== attr[2]) return false;
  }
  return true;
}

class FakeTarget {
  constructor() { this.listeners = []; }
  addEventListener(type, fn, capture = false) { this.listeners.push({ type, fn, capture: capture === true || capture?.capture === true }); }
  removeEventListener(type, fn, capture = false) {
    const flag = capture === true || capture?.capture === true;
    this.listeners = this.listeners.filter(l => !(l.type === type && l.fn === fn && l.capture === flag));
  }
}

class FakeElement extends FakeTarget {
  constructor(doc, tag, attrs = {}) {
    super();
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.children = [];
    this.parentNode = null;
    this.value = '';
    this.selectionStart = null;
    this.selectionEnd = null;
    for (const [name, value] of Object.entries(attrs)) {
      if (name === 'onclick') this.addEventListener('click', value);
      else if (name === 'value') { this.value = value; this.selectionStart = this.selectionEnd = value.length; }
      else this.setAttribute(name, value);
    }
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  hasAttribute(name) { return this.attributes.has(name); }
  get tabIndex() { return Number(this.getAttribute('tabindex') ?? (['BUTTON', 'INPUT'].includes(this.tagName) ? 0 : -1)); }
  set tabIndex(value) { this.setAttribute('tabindex', value); }
  get disabled() { return this.hasAttribute('disabled'); }
  set disabled(value) { if (value) this.setAttribute('disabled', ''); else this.removeAttribute('disabled'); }
  get hidden() { return this.hasAttribute('hidden'); }
  get type() { return this.getAttribute('type') || (this.tagName === 'INPUT' ? 'text' : ''); }
  get isConnected() {
    let node = this;
    while (node.parentNode) node = node.parentNode;
    return node === this.ownerDocument.documentElement;
  }
  append(...nodes) { for (const node of nodes) { node.remove(); node.parentNode = this; this.children.push(node); } return this; }
  remove() {
    if (!this.parentNode) return;
    const doc = this.ownerDocument;
    if (this.contains(doc.activeElement)) doc.activeElement = doc.body;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }
  replaceChildren(...nodes) { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  contains(node) { for (let n = node; n; n = n.parentNode) if (n === this) return true; return false; }
  matches(selector) { return selector.split(',').some(part => matchSimple(this, part.trim())); }
  querySelectorAll(selector) {
    const out = [];
    const walk = node => { for (const child of node.children) { if (child.matches(selector)) out.push(child); walk(child); } };
    walk(this);
    return out;
  }
  focus() {
    const doc = this.ownerDocument;
    if (!this.isConnected || this.disabled || doc.activeElement === this) return;
    const previous = doc.activeElement;
    doc.activeElement = this;
    if (previous && previous !== doc.body) dispatch(previous, new FakeEvent('focusout', { relatedTarget: this }));
    dispatch(this, new FakeEvent('focusin', { relatedTarget: previous }));
  }
  click() { dispatch(this, new FakeEvent('click')); }
}

function dispatch(target, event) {
  event.target = target;
  const path = [];
  for (let node = target; node; node = node.parentNode) path.push(node);
  path.push(target.ownerDocument);
  const invoke = (node, capture) => {
    for (const l of [...node.listeners]) {
      if (l.type !== event.type || l.capture !== capture) continue;
      event.currentTarget = node;
      l.fn(event);
    }
  };
  for (let i = path.length - 1; i >= 1; i--) { invoke(path[i], true); if (event.stopped) return event; }
  invoke(path[0], true);
  if (event.stopped) return event;
  invoke(path[0], false);
  for (let i = 1; i < path.length && event.bubbles && !event.stopped; i++) invoke(path[i], false);
  return event;
}

function makeDocument() {
  const doc = new FakeTarget();
  doc.documentElement = new FakeElement(doc, 'html');
  doc.body = new FakeElement(doc, 'body');
  doc.documentElement.append(doc.body);
  doc.activeElement = doc.body;
  doc.el = (tag, attrs = {}, ...children) => new FakeElement(doc, tag, attrs).append(...children);
  return doc;
}

/** Keydown on the focused element; an unprevented Enter/Space on a button clicks it. */
function press(doc, key, init = {}) {
  const target = doc.activeElement;
  const event = dispatch(target, new FakeEvent('keydown', { key, ...init }));
  if (!event.defaultPrevented && (key === 'Enter' || key === ' ') && target.tagName === 'BUTTON' && !target.disabled) target.click();
  return event;
}

const tabbable = items => items.filter(el => el.tabIndex === 0);

// ------------------------------------------------------------- pure helpers

test('compositeKeyIntent maps arrows by orientation and direction', () => {
  assert.equal(compositeKeyIntent('ArrowRight'), 'next');
  assert.equal(compositeKeyIntent('ArrowLeft'), 'previous');
  assert.equal(compositeKeyIntent('ArrowDown'), null);
  assert.equal(compositeKeyIntent('ArrowDown', { orientation: 'vertical' }), 'next');
  assert.equal(compositeKeyIntent('ArrowRight', { orientation: 'vertical' }), null);
  assert.equal(compositeKeyIntent('ArrowUp', { orientation: 'both' }), 'previous');
  assert.equal(compositeKeyIntent('ArrowRight', { orientation: 'both' }), 'next');
  assert.equal(compositeKeyIntent('ArrowRight', { direction: 'rtl' }), 'previous');
  assert.equal(compositeKeyIntent('ArrowLeft', { direction: 'rtl' }), 'next');
  assert.equal(compositeKeyIntent('Home'), 'first');
  assert.equal(compositeKeyIntent('End'), 'last');
  assert.equal(compositeKeyIntent('End', { homeEnd: false }), null);
  assert.equal(compositeKeyIntent('Tab'), null);
});

test('nextCompositeIndex wraps, skips, stops at the edge without loop', () => {
  const skip = set => i => set.has(i);
  assert.equal(nextCompositeIndex({ count: 4, current: 3, intent: 'next' }), 0);
  assert.equal(nextCompositeIndex({ count: 4, current: 0, intent: 'previous' }), 3);
  assert.equal(nextCompositeIndex({ count: 4, current: 0, intent: 'next', isSkipped: skip(new Set([1, 2])) }), 3);
  assert.equal(nextCompositeIndex({ count: 4, current: 3, intent: 'next', loop: false }), 3);
  assert.equal(nextCompositeIndex({ count: 4, current: 0, intent: 'previous', loop: false }), 0);
  assert.equal(nextCompositeIndex({ count: 4, current: -1, intent: 'next', isSkipped: skip(new Set([0])) }), 1);
  assert.equal(nextCompositeIndex({ count: 4, current: -1, intent: 'previous' }), 3);
  assert.equal(nextCompositeIndex({ count: 4, current: 2, intent: 'first', isSkipped: skip(new Set([0])) }), 1);
  assert.equal(nextCompositeIndex({ count: 4, current: 0, intent: 'last', isSkipped: skip(new Set([3])) }), 2);
  assert.equal(nextCompositeIndex({ count: 3, current: 1, intent: 'next', isSkipped: () => true }), -1);
  assert.equal(nextCompositeIndex({ count: 0, current: 0, intent: 'next' }), -1);
});

test('textInputKeepsKey hands arrows to the field until the caret reaches the edge', () => {
  const at = (caret, length, extra = {}) => ({ selectionStart: caret, selectionEnd: caret, valueLength: length, ...extra });
  assert.equal(textInputKeepsKey({ intent: 'next', ...at(2, 5) }), true);
  assert.equal(textInputKeepsKey({ intent: 'next', ...at(5, 5) }), false);
  assert.equal(textInputKeepsKey({ intent: 'previous', ...at(2, 5) }), true);
  assert.equal(textInputKeepsKey({ intent: 'previous', ...at(0, 5) }), false);
  assert.equal(textInputKeepsKey({ intent: 'next', ...at(5, 5, { shiftKey: true }) }), true);
  assert.equal(textInputKeepsKey({ intent: 'next', selectionStart: 1, selectionEnd: 5, valueLength: 5 }), true);
  assert.equal(textInputKeepsKey({ intent: 'first', ...at(5, 5) }), true);
  assert.equal(textInputKeepsKey({ intent: 'first', ...at(0, 0) }), false);
  assert.equal(textInputKeepsKey({ intent: 'next', selectionStart: null, selectionEnd: null, valueLength: 3 }), true);
});

test('entryFocusIndex prefers the last focused, then the selected, then the first usable item', () => {
  const skipped = i => i === 0;
  assert.equal(entryFocusIndex({ count: 4, isSkipped: skipped, lastFocused: 2, selected: 3 }), 2);
  assert.equal(entryFocusIndex({ count: 4, isSkipped: skipped, lastFocused: 0, selected: 3 }), 3);
  assert.equal(entryFocusIndex({ count: 4, isSkipped: skipped, lastFocused: 9, selected: -1 }), 1);
  assert.equal(entryFocusIndex({ count: 0 }), -1);
});

test('tooltipContent keeps the name apart from the shortcut text', () => {
  assert.deepEqual(tooltipContent({ name: '뒤로', shortcut: '⌘[', ariaShortcut: 'Meta+BracketLeft' }),
    { ariaLabel: '뒤로', tooltip: '뒤로 (⌘[)', ariaKeyShortcuts: 'Meta+BracketLeft' });
  assert.deepEqual(tooltipContent({ name: '새로고침' }), { ariaLabel: '새로고침', tooltip: '새로고침', ariaKeyShortcuts: null });
});

// ------------------------------------------------------------ tooltip state

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) { pending.set(++seq, { fn, at: now + ms }); return seq; },
    clearTimeout(id) { pending.delete(id); },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...pending].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
  };
}

test('tooltip waits 1500 ms, then neighbours open at once until the 500 ms cool-down ends', () => {
  const timers = fakeTimers();
  const seen = [];
  const tips = createTooltipController({ timers, onChange: state => seen.push({ ...state }) });
  assert.equal(TOOLTIP_DELAY_MS, 1500);
  assert.equal(TOOLTIP_COOLDOWN_MS, 500);
  tips.show('back');
  timers.advance(1499);
  assert.equal(tips.getState().openId, null);
  timers.advance(1);
  assert.deepEqual(seen.at(-1), { openId: 'back', instant: false });
  // Swapping while open: the next one replaces it without waiting.
  tips.show('forward');
  assert.deepEqual(seen.at(-1), { openId: 'forward', instant: true });
  tips.hide('forward', { immediate: true });
  assert.equal(tips.getState().openId, null);
  timers.advance(200);
  tips.show('reload');
  assert.deepEqual(seen.at(-1), { openId: 'reload', instant: true });
  tips.hide('reload', { immediate: true });
  timers.advance(500);
  tips.show('back');
  assert.equal(tips.getState().openId, null, 'after the cool-down the warm-up starts over');
  timers.advance(1500);
  assert.equal(tips.getState().openId, 'back');
});

test('tooltip hover-out closes after the close delay; leaving before the delay cancels it; Escape closes', () => {
  const timers = fakeTimers();
  const tips = createTooltipController({ timers });
  tips.show('a');
  timers.advance(800);
  tips.hide('a');
  timers.advance(2000);
  assert.equal(tips.getState().openId, null, 'never opened');
  tips.show('a', { immediate: true });
  assert.equal(tips.getState().openId, 'a');
  tips.hide('a');
  timers.advance(499);
  assert.equal(tips.getState().openId, 'a');
  tips.show('a');
  timers.advance(1000);
  assert.equal(tips.getState().openId, 'a', 'coming back cancels the pending close');
  assert.equal(tips.escape(), true);
  assert.equal(tips.getState().openId, null);
  assert.equal(tips.escape(), false);
  tips.dispose();
});

// ------------------------------------------------------------------ toolbar

function browserToolbar(doc, counts) {
  const count = name => () => { counts[name] = (counts[name] || 0) + 1; };
  const back = doc.el('button', { 'aria-label': '뒤로', onclick: count('back') });
  const forward = doc.el('button', { 'aria-label': '앞으로', disabled: '', onclick: count('forward') });
  const reload = doc.el('button', { 'aria-label': '새로고침', onclick: count('reload') });
  const url = doc.el('input', { 'aria-label': '주소', value: 'example.com' });
  const more = doc.el('button', { 'aria-label': '더 보기', onclick: count('more') });
  const root = doc.el('div', {}, back, forward, reload, url, more);
  doc.body.append(root);
  return { root, back, forward, reload, url, more, items: [back, forward, reload, url, more] };
}

test('BRW-01 toolbar: one Tab stop, arrows move, native-disabled is skipped, ends wrap, Home/End', () => {
  const doc = makeDocument();
  const bar = browserToolbar(doc, {});
  bindToolbar(bar.root, { label: 'Browser 카드 도구' });
  assert.equal(bar.root.getAttribute('role'), 'toolbar');
  assert.equal(bar.root.getAttribute('aria-label'), 'Browser 카드 도구');
  assert.deepEqual(tabbable(bar.items), [bar.back]);
  bar.back.focus();
  const moved = press(doc, 'ArrowRight');
  assert.equal(moved.defaultPrevented, true);
  assert.equal(doc.activeElement, bar.reload, 'forward is natively disabled and skipped');
  assert.deepEqual(tabbable(bar.items), [bar.reload]);
  press(doc, 'End');
  assert.equal(doc.activeElement, bar.more);
  press(doc, 'ArrowRight');
  assert.equal(doc.activeElement, bar.back, 'wraps from last to first');
  press(doc, 'ArrowLeft');
  assert.equal(doc.activeElement, bar.more);
  press(doc, 'Home');
  assert.equal(doc.activeElement, bar.back);
  assert.equal(press(doc, 'ArrowDown').defaultPrevented, false, 'a horizontal toolbar leaves Up/Down alone');
  assert.equal(press(doc, 'ArrowRight', { ctrlKey: true }).defaultPrevented, false);
});

test('BRW-01 toolbar: a focused button that turns aria-disabled keeps focus and ignores Enter and clicks', () => {
  const doc = makeDocument();
  const counts = {};
  const bar = browserToolbar(doc, counts);
  bindToolbar(bar.root);
  bar.back.focus();
  press(doc, 'Enter');
  assert.equal(counts.back, 1);
  setItemDisabled(bar.back, true);
  assert.equal(doc.activeElement, bar.back, 'focus stays on the disabled Back button');
  assert.equal(bar.back.getAttribute('aria-disabled'), 'true');
  assert.equal(bar.back.hasAttribute('disabled'), false);
  press(doc, 'Enter');
  press(doc, ' ');
  bar.back.click();
  assert.equal(counts.back, 1, 'aria-disabled blocks activation');
  press(doc, 'ArrowRight');
  assert.equal(doc.activeElement, bar.reload);
  press(doc, 'ArrowLeft');
  assert.equal(doc.activeElement, bar.back, 'aria-disabled toolbar buttons stay reachable');
  setItemDisabled(bar.back, false);
  bar.back.click();
  assert.equal(counts.back, 2);
  setItemDisabled(bar.reload, true, { focusable: false });
  assert.equal(bar.reload.hasAttribute('disabled'), true);
  assert.equal(bar.reload.hasAttribute('aria-disabled'), false);
});

test('BRW-01 toolbar: the address field keeps arrows until the caret is at its edge', () => {
  const doc = makeDocument();
  const bar = browserToolbar(doc, {});
  bindToolbar(bar.root);
  bar.url.focus();
  bar.url.selectionStart = bar.url.selectionEnd = 3;
  assert.equal(press(doc, 'ArrowRight').defaultPrevented, false);
  assert.equal(press(doc, 'ArrowLeft').defaultPrevented, false);
  assert.equal(press(doc, 'Home').defaultPrevented, false);
  assert.equal(doc.activeElement, bar.url);
  bar.url.selectionStart = bar.url.selectionEnd = bar.url.value.length;
  press(doc, 'ArrowRight');
  assert.equal(doc.activeElement, bar.more);
  bar.url.focus();
  bar.url.selectionStart = bar.url.selectionEnd = 0;
  press(doc, 'ArrowLeft');
  assert.equal(doc.activeElement, bar.reload);
});

test('BRW-01 toolbar: leaving and re-entering keeps the last item as the Tab stop; binding twice is one binding', () => {
  const doc = makeDocument();
  const bar = browserToolbar(doc, {});
  const outside = doc.el('button', { 'aria-label': '밖' });
  doc.body.append(outside);
  const first = bindToolbar(bar.root);
  assert.equal(bindToolbar(bar.root), first);
  bar.back.focus();
  press(doc, 'ArrowRight');
  outside.focus();
  first.sync();
  assert.deepEqual(tabbable(bar.items), [bar.reload], 'Tab back in lands on Reload');
  bar.reload.focus();
  press(doc, 'ArrowRight');
  assert.equal(doc.activeElement, bar.url, 'one key moves one step even after binding twice');
  first.focusItem(0);
  assert.equal(doc.activeElement, bar.back);
  first.destroy();
  press(doc, 'ArrowRight');
  assert.equal(doc.activeElement, bar.back, 'destroyed binding no longer moves focus');
});

// -------------------------------------------------------------- radio group

function engineChoices(doc, state, { disabledIds = [] } = {}) {
  const root = doc.el('div', { 'aria-label': 'AI 엔진' });
  const render = () => {
    root.replaceChildren(...state.ids.map(id => doc.el('button', {
      role: 'radio', 'data-engine': id, 'aria-checked': String(id === state.current),
      ...(disabledIds.includes(id) ? { disabled: 'true' } : {}),
      onclick: () => { state.current = id; state.clicks.push(id); if (state.rerender) render(); },
    })));
  };
  render();
  return { root, render };
}

test('DSN-04 radio group: arrows check the next enabled choice in all four directions and skip disabled ones', () => {
  const doc = makeDocument();
  const state = { ids: ['codex', 'claude', 'local'], current: 'codex', clicks: [], rerender: false };
  const group = engineChoices(doc, state, { disabledIds: ['claude'] });
  doc.body.append(group.root);
  bindRadioGroup(group.root);
  const items = () => group.root.querySelectorAll('[role="radio"]');
  assert.deepEqual(tabbable(items()).map(el => el.getAttribute('data-engine')), ['codex'], 'the checked choice is the Tab stop');
  items()[0].focus();
  press(doc, 'ArrowDown');
  assert.equal(doc.activeElement.getAttribute('data-engine'), 'local');
  assert.deepEqual(state.clicks, ['local']);
  press(doc, 'ArrowRight');
  assert.equal(doc.activeElement.getAttribute('data-engine'), 'codex', 'wraps');
  press(doc, 'ArrowUp');
  assert.equal(doc.activeElement.getAttribute('data-engine'), 'local');
  assert.deepEqual(state.clicks, ['local', 'codex', 'local']);
});

test('DSN-04 radio group: a click that re-renders the choices keeps focus on the same choice', () => {
  const doc = makeDocument();
  const state = { ids: ['low', 'medium', 'high'], current: 'low', clicks: [], rerender: true };
  const group = engineChoices(doc, state);
  doc.body.append(group.root);
  bindRadioGroup(group.root, { itemKey: el => el.getAttribute('data-engine') });
  group.root.querySelectorAll('[role="radio"]')[0].focus();
  press(doc, 'ArrowRight');
  const active = doc.activeElement;
  assert.equal(active.isConnected, true);
  assert.equal(active.getAttribute('data-engine'), 'medium');
  assert.equal(active.getAttribute('aria-checked'), 'true');
  assert.equal(active.tabIndex, 0);
  press(doc, 'ArrowRight');
  assert.equal(doc.activeElement.getAttribute('data-engine'), 'high');
});

test('DSN-04 radio group: a container replaced after the selection gets focus back through restoreKey', () => {
  const doc = makeDocument();
  const state = { ids: ['gpt-5', 'gpt-5-mini'], current: 'gpt-5', clicks: [], rerender: false };
  const options = { itemKey: el => el.getAttribute('data-engine'), restoreKey: 'chat-engine-models' };
  const first = engineChoices(doc, state);
  doc.body.append(first.root);
  bindRadioGroup(first.root, options);
  first.root.querySelectorAll('[role="radio"]')[0].focus();
  press(doc, 'ArrowDown');
  // The surface re-renders later and swaps in a new container.
  first.root.remove();
  assert.equal(doc.activeElement, doc.body, 'focus was lost with the old container');
  const second = engineChoices(doc, state);
  doc.body.append(second.root);
  bindRadioGroup(second.root, options);
  assert.equal(doc.activeElement.getAttribute('data-engine'), 'gpt-5-mini');
  assert.equal(doc.activeElement.parentNode, second.root);
  // A later bind with nothing pending leaves focus where it is.
  const outside = doc.el('button');
  doc.body.append(outside);
  outside.focus();
  bindRadioGroup(second.root, options);
  assert.equal(doc.activeElement, outside);
});

test('radio group of non-button items: Space checks the focused item', () => {
  const doc = makeDocument();
  const picked = [];
  const items = ['a', 'b'].map(id => doc.el('div', { role: 'radio', 'aria-checked': 'false', id, onclick: () => picked.push(id) }));
  const root = doc.el('div', {}, ...items);
  doc.body.append(root);
  bindRadioGroup(root);
  items[1].focus();
  const event = press(doc, ' ');
  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(picked, ['b']);
});

// --------------------------------------------------------------------- tabs

function settingsTabs(doc, state) {
  const root = doc.el('div', { role: 'tablist' });
  const render = () => root.replaceChildren(...['account', 'agents'].map(id => doc.el('button', {
    role: 'tab', 'data-testid': `settings-tab-${id}`, 'aria-selected': String(state.active === id),
    onclick: () => { state.active = id; render(); },
  })));
  render();
  doc.body.append(root);
  return root;
}

test('DSN-04 tabs: automatic activation selects on arrow even though the tab list re-renders', () => {
  const doc = makeDocument();
  const state = { active: 'account' };
  const root = settingsTabs(doc, state);
  bindTabs(root, { itemKey: el => el.getAttribute('data-testid') });
  root.querySelectorAll('[role="tab"]')[0].focus();
  press(doc, 'ArrowRight');
  assert.equal(state.active, 'agents');
  assert.equal(doc.activeElement.getAttribute('data-testid'), 'settings-tab-agents');
  assert.equal(doc.activeElement.isConnected, true);
  press(doc, 'Home');
  assert.equal(state.active, 'account');
});

test('DSN-04 tabs: manual activation moves focus only; Enter selects', () => {
  const doc = makeDocument();
  const state = { active: 'account' };
  const root = settingsTabs(doc, state);
  bindTabs(root, { activation: 'manual', itemKey: el => el.getAttribute('data-testid') });
  root.querySelectorAll('[role="tab"]')[0].focus();
  press(doc, 'ArrowRight');
  assert.equal(state.active, 'account');
  assert.equal(doc.activeElement.getAttribute('data-testid'), 'settings-tab-agents');
  press(doc, 'Enter');
  assert.equal(state.active, 'agents');
});

test('focusSnapshot and restoreFocus put focus back on the same item after a re-render', () => {
  const doc = makeDocument();
  const make = () => doc.el('div', {}, ...['x', 'y', 'z'].map(id => doc.el('button', { tabindex: '-1', 'data-id': id })));
  const panel = doc.el('div', {}, make());
  doc.body.append(panel);
  panel.querySelectorAll('[data-id]')[1].focus();
  const key = el => el.getAttribute('data-id');
  const snapshot = focusSnapshot(panel, { selector: '[data-id]', itemKey: key });
  assert.deepEqual(snapshot, { index: 1, key: 'y', selector: '[data-id]' });
  panel.replaceChildren(make());
  assert.equal(restoreFocus(panel, snapshot, { itemKey: key }), true);
  assert.equal(doc.activeElement.getAttribute('data-id'), 'y');
  assert.equal(restoreFocus(panel, null), false);
});

// ----------------------------------------------------------------- tooltips

test('BRW-01 keyboard tooltip: opens on focus-visible, follows arrow moves at once, Escape closes it first', () => {
  const doc = makeDocument();
  const timers = fakeTimers();
  const bar = browserToolbar(doc, {});
  for (const button of [bar.back, bar.reload, bar.more]) {
    const content = tooltipContent({ name: button.getAttribute('aria-label'), shortcut: button === bar.back ? '⌘[' : '' });
    button.setAttribute('data-egd-tooltip', content.tooltip);
  }
  bindToolbar(bar.root);
  const renders = [];
  const tips = bindTooltipTriggers(bar.root, {
    controller: createTooltipController({ timers }),
    render: state => renders.push({ openId: state.openId, text: state.text, instant: state.instant }),
    isFocusVisible: () => true,
  });
  const below = [];
  doc.body.addEventListener('keydown', event => { if (event.key === 'Escape') below.push('escape'); });

  bar.back.focus();
  timers.advance(1500);
  assert.equal(renders.at(-1).text, '뒤로 (⌘[)');
  assert.equal(bar.back.getAttribute('aria-describedby'), 'egd-tooltip', 'text adds the shortcut to the name');
  press(doc, 'ArrowRight');
  assert.equal(doc.activeElement, bar.reload);
  assert.deepEqual(renders.at(-1), { openId: bar.reload.getAttribute('data-egd-tooltip-id'), text: '새로고침', instant: true });
  assert.equal(bar.back.hasAttribute('aria-describedby'), false);
  assert.equal(bar.reload.hasAttribute('aria-describedby'), false, 'same text as the name adds no description');

  press(doc, 'Escape');
  assert.equal(tips.controller.getState().openId, null);
  assert.deepEqual(below, [], 'Escape closed the tooltip and stopped there');
  press(doc, 'Escape');
  assert.deepEqual(below, ['escape'], 'with no tooltip open Escape reaches the layer below');
  tips.destroy();
});

test('keyboard tooltip: pointer press and blur close it; focus without focus-visible does not open it', () => {
  const doc = makeDocument();
  const timers = fakeTimers();
  const button = doc.el('button', { 'aria-label': '닫기', 'data-egd-tooltip': '닫기 (Esc)' });
  const other = doc.el('button');
  const root = doc.el('div', {}, button, other);
  doc.body.append(root);
  let visible = false;
  const tips = bindTooltipTriggers(root, { controller: createTooltipController({ timers }), isFocusVisible: () => visible });
  button.focus();
  timers.advance(2000);
  assert.equal(tips.controller.getState().openId, null);
  other.focus();
  visible = true;
  button.focus();
  timers.advance(1500);
  assert.notEqual(tips.controller.getState().openId, null);
  dispatch(button, new FakeEvent('pointerdown'));
  assert.equal(tips.controller.getState().openId, null);
  dispatch(button, new FakeEvent('mouseover', { relatedTarget: other }));
  assert.notEqual(tips.controller.getState().openId, null, 'still warmed up, hover opens at once');
  other.focus();
  dispatch(button, new FakeEvent('mouseout', { relatedTarget: other }));
  timers.advance(500);
  assert.equal(tips.controller.getState().openId, null);
  tips.destroy();
});
