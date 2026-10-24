// BRW-01 · DSN-04: keyboard movement inside toolbars, radio groups and tab
// lists (Tab once to enter, arrows to move), aria-disabled items that keep
// focus, and keyboard-visible tooltips.
//
// Patterns followed (rewritten here, not copied):
// - W3C ARIA Authoring Practices (W3C Software and Document License,
//   Copyright (c) W3C) content/patterns/toolbar/examples/js/FormatToolbar.js,
//   radio/examples/js/radio.js, tabs/examples/js/tabs-automatic.js,
//   toolbar-pattern.html, practices/keyboard-interface (disabled controls):
//   roving tabindex, wrap at both ends, Home/End, Space checks a radio.
// - mui/base-ui (MIT, Copyright (c) 2019 Material-UI SAS)
//   internals/composite/root/useCompositeRoot.ts (text-input caret boundary,
//   RTL arrows, modifier keys), utils/useFocusableWhenDisabled.ts and
//   toolbar/button/ToolbarButton.tsx (toolbar buttons stay focusable when
//   disabled; activation keys are swallowed, Tab is not).
// - adobe/react-spectrum (Apache-2.0, Copyright 2020/2023 Adobe)
//   react-aria toolbar/useToolbar.ts (restore the last focused item on
//   re-entry), react-stately tooltip/useTooltipTriggerState.ts and react-aria
//   tooltip/useTooltipTrigger.ts (1500 ms warm-up shared across tooltips,
//   500 ms cool-down, open on focus-visible, close on blur/press/Escape).
// - Firefox moz-button (MPL-2.0, pattern only): accessible name (aria-label)
//   and tooltip text are separate values.
//
// The pure functions run in node tests; the binders only take elements and use
// standard DOM calls, so the surface (eg-desk-surface.uc.js) owns rendering.

export const TOOLTIP_DELAY_MS = 1500;
export const TOOLTIP_COOLDOWN_MS = 500;

const ROLE_DEFAULTS = Object.freeze({
  toolbar: { orientation: 'horizontal', focusableWhenDisabled: true, selectionFollowsFocus: false,
    selector: 'button, input, select, textarea, a[href], [role="button"], [role="checkbox"], [role="switch"]' },
  radiogroup: { orientation: 'both', focusableWhenDisabled: false, selectionFollowsFocus: true, selector: '[role="radio"]' },
  tablist: { orientation: 'horizontal', focusableWhenDisabled: false, selectionFollowsFocus: true, selector: '[role="tab"]' },
});

// ------------------------------------------------------------ pure helpers

/**
 * Which way a key moves inside a composite widget: 'next' | 'previous' |
 * 'first' | 'last' | null. orientation 'both' (radio groups) takes all four
 * arrows; horizontal arrows swap in RTL.
 */
export function compositeKeyIntent(key, { orientation = 'horizontal', direction = 'ltr', homeEnd = true } = {}) {
  const rtl = direction === 'rtl';
  const right = rtl ? 'previous' : 'next';
  const left = rtl ? 'next' : 'previous';
  switch (key) {
    case 'ArrowRight': return orientation === 'vertical' ? null : right;
    case 'ArrowLeft': return orientation === 'vertical' ? null : left;
    case 'ArrowDown': return orientation === 'horizontal' ? null : 'next';
    case 'ArrowUp': return orientation === 'horizontal' ? null : 'previous';
    case 'Home': return homeEnd ? 'first' : null;
    case 'End': return homeEnd ? 'last' : null;
    default: return null;
  }
}

/**
 * Index the intent lands on, skipping items `isSkipped(i)` says to skip.
 * current -1 (focus on no item) treats next as first and previous as last.
 * Without loop the edge item stays. Returns -1 when every item is skipped.
 */
export function nextCompositeIndex({ count, current = -1, intent, isSkipped = () => false, loop = true }) {
  if (!Number.isInteger(count) || count <= 0) return -1;
  const usable = i => i >= 0 && i < count && !isSkipped(i);
  const scan = (from, step) => {
    for (let i = from; i >= 0 && i < count; i += step) if (usable(i)) return i;
    return -1;
  };
  if (intent === 'first' || (intent === 'next' && current < 0)) return scan(0, 1);
  if (intent === 'last' || (intent === 'previous' && current < 0)) return scan(count - 1, -1);
  if (intent !== 'next' && intent !== 'previous') return usable(current) ? current : -1;
  const step = intent === 'next' ? 1 : -1;
  let i = current;
  for (let n = 0; n < count; n++) {
    i += step;
    if (i < 0 || i >= count) {
      if (!loop) return usable(current) ? current : -1;
      i = (i + count) % count;
    }
    if (usable(i)) return i;
  }
  return usable(current) ? current : -1;
}

/**
 * True when an arrow/Home/End press inside a text input should stay with the
 * input (base-ui caret boundary): no selection API, Shift held, a selection,
 * the caret not at the edge the key moves past, or Home/End in a non-empty field.
 */
export function textInputKeepsKey({ intent, selectionStart, selectionEnd, valueLength, shiftKey = false }) {
  if (selectionStart == null || shiftKey || selectionStart !== selectionEnd) return true;
  if (intent === 'next') return selectionStart < valueLength;
  if (intent === 'previous') return selectionStart > 0;
  if (intent === 'first' || intent === 'last') return valueLength > 0;
  return true;
}

/**
 * The item that gets tabindex=0: the last focused item if still usable, else
 * the selected one (checked radio, selected tab), else the first usable item.
 */
export function entryFocusIndex({ count, isSkipped = () => false, lastFocused = -1, selected = -1 }) {
  const usable = i => Number.isInteger(i) && i >= 0 && i < count && !isSkipped(i);
  if (usable(lastFocused)) return lastFocused;
  if (usable(selected)) return selected;
  return nextCompositeIndex({ count, intent: 'first', isSkipped });
}

/** Accessible name, tooltip text and aria-keyshortcuts kept apart (moz-button). */
export function tooltipContent({ name, shortcut = '', ariaShortcut = '' } = {}) {
  const label = String(name || '').trim();
  const keys = String(shortcut || '').trim();
  return {
    ariaLabel: label,
    tooltip: keys ? `${label} (${keys})` : label,
    ariaKeyShortcuts: String(ariaShortcut || '').trim() || null,
  };
}

// ---------------------------------------------------------- tooltip state

/**
 * One controller per window. show/hide follow react-stately: the first tooltip
 * waits `delay`; while warmed up the next opens at once (instant=true); after
 * the last one closes, the warm-up ends `cooldown` later. Timers are injected
 * so tests run without waiting. onChange and subscribe() listeners receive
 * {openId, instant}.
 */
export function createTooltipController({
  delay = TOOLTIP_DELAY_MS,
  closeDelay = TOOLTIP_COOLDOWN_MS,
  cooldown = TOOLTIP_COOLDOWN_MS,
  timers = { setTimeout: (...a) => setTimeout(...a), clearTimeout: id => clearTimeout(id) },
  onChange = () => {},
} = {}) {
  let openId = null;
  let instant = false;
  let warmedUp = false;
  let pendingId = null;
  let warmupTimer = null;
  let closeTimer = null;
  let cooldownTimer = null;
  const listeners = new Set([onChange]);
  const clear = timer => { if (timer != null) timers.clearTimeout(timer); return null; };
  const emit = () => { for (const listener of [...listeners]) listener({ openId, instant }); };
  const open = (id, isInstant) => {
    closeTimer = clear(closeTimer);
    warmupTimer = clear(warmupTimer);
    cooldownTimer = clear(cooldownTimer);
    pendingId = null;
    warmedUp = true;
    if (openId === id && instant === isInstant) return;
    openId = id;
    instant = isInstant;
    emit();
  };
  const startCooldown = () => {
    cooldownTimer = clear(cooldownTimer);
    cooldownTimer = timers.setTimeout(() => { cooldownTimer = null; warmedUp = false; }, Math.max(cooldown, closeDelay));
  };
  const closeNow = (isInstant = false) => {
    closeTimer = clear(closeTimer);
    if (openId == null) return false;
    openId = null;
    instant = isInstant;
    emit();
    return true;
  };
  return {
    show(id, { immediate = false } = {}) {
      if (id == null) return;
      if (openId === id) { closeTimer = clear(closeTimer); cooldownTimer = clear(cooldownTimer); return; }
      if (immediate || warmedUp) { open(id, openId != null || warmedUp); return; }
      if (pendingId === id && warmupTimer != null) return;
      warmupTimer = clear(warmupTimer);
      pendingId = id;
      warmupTimer = timers.setTimeout(() => { warmupTimer = null; open(id, false); }, delay);
    },
    hide(id, { immediate = false } = {}) {
      if (pendingId === id) { warmupTimer = clear(warmupTimer); pendingId = null; }
      if (openId !== id) return;
      if (immediate || closeDelay <= 0) closeNow();
      else if (closeTimer == null) closeTimer = timers.setTimeout(() => { closeTimer = null; closeNow(); }, closeDelay);
      if (warmedUp) startCooldown();
    },
    /** Escape: closes the open tooltip at once; true if one was open. */
    escape() {
      warmupTimer = clear(warmupTimer);
      pendingId = null;
      const closed = closeNow();
      if (closed && warmedUp) startCooldown();
      return closed;
    },
    getState: () => ({ openId, instant, warmedUp, pendingId }),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() {
      warmupTimer = clear(warmupTimer);
      closeTimer = clear(closeTimer);
      cooldownTimer = clear(cooldownTimer);
      pendingId = null;
      warmedUp = false;
      openId = null;
    },
  };
}

// ------------------------------------------------------------- DOM binders

const bindings = new WeakMap();
// restoreKey -> itemKey of the item just selected, for widgets the surface
// re-renders after a selection (the old root is gone when the new one binds).
const pendingRestore = new Map();

const isTrue = value => value === 'true';
const isNativeDisabled = el => el.disabled === true || el.hasAttribute?.('disabled') === true;
const isAriaDisabled = el => isTrue(el.getAttribute?.('aria-disabled'));
const isHidden = el => el.hidden === true || el.hasAttribute?.('hidden') === true || (el.tagName === 'INPUT' && el.type === 'hidden');
const isTextInput = el => (el.tagName === 'INPUT' && !['button', 'checkbox', 'radio', 'submit', 'reset', 'image', 'range', 'color', 'file'].includes(el.type))
  || el.tagName === 'TEXTAREA';
const isNativeActivator = el => el.tagName === 'BUTTON' || (el.tagName === 'INPUT' && ['button', 'submit', 'reset', 'checkbox', 'radio'].includes(el.type));

function itemFrom(items, target) {
  for (let node = target; node; node = node.parentNode) {
    const index = items.indexOf(node);
    if (index >= 0) return index;
  }
  return -1;
}

/**
 * Marks a composite item disabled. Toolbar items keep focus (aria-disabled,
 * no native `disabled`), so a Back button that turns off while focused does
 * not drop focus; `focusable: false` uses native disabled.
 */
export function setItemDisabled(el, disabled, { focusable = true } = {}) {
  if (focusable) {
    if (disabled) el.setAttribute('aria-disabled', 'true'); else el.removeAttribute('aria-disabled');
    el.removeAttribute('disabled');
    if ('disabled' in el) el.disabled = false;
  } else {
    el.removeAttribute('aria-disabled');
    if (disabled) el.setAttribute('disabled', 'true'); else el.removeAttribute('disabled');
    if ('disabled' in el) el.disabled = !!disabled;
  }
}

/**
 * Binds one composite widget. Listeners sit on `root` (event delegation), and
 * items are re-read on every key, so re-rendered children keep working.
 * Calling again on the same root re-syncs and returns the same binding.
 *
 * options: role ('toolbar' | 'radiogroup' | 'tablist'), label (aria-label),
 * items() or selector, orientation, direction, loop, focusableWhenDisabled,
 * selectionFollowsFocus, onSelect(el, index, event) (default el.click()),
 * itemKey(el) (matches an item again after a re-render),
 * resolveRoot() (the live root when a click re-renders the container at once),
 * restoreKey (string naming the widget: after a selection re-renders it later,
 * the next bind with the same restoreKey puts focus back on the selected item
 * if focus was lost).
 */
export function bindComposite(root, options = {}) {
  const existing = bindings.get(root);
  if (existing) { existing.update(options); existing.sync(); return existing; }
  const role = options.role || root.getAttribute('role') || 'toolbar';
  const config = { ...ROLE_DEFAULTS[role] || ROLE_DEFAULTS.toolbar, loop: true, direction: 'ltr', ...options };
  let lastFocusedKey = null;

  const keyOf = (el, index) => (config.itemKey ? config.itemKey(el) : index);
  const readItems = (container = root) => {
    const list = config.items ? [...config.items(container)] : [...container.querySelectorAll(config.selector)];
    return list.filter(el => !isHidden(el));
  };
  const skipped = items => i => isNativeDisabled(items[i]) || (!config.focusableWhenDisabled && isAriaDisabled(items[i]));
  const selectedIndex = items => items.findIndex(el => isTrue(el.getAttribute('aria-checked')) || isTrue(el.getAttribute('aria-selected')));
  const orientation = () => {
    const aria = root.getAttribute('aria-orientation');
    return config.orientation === 'both' ? 'both' : aria === 'vertical' || aria === 'horizontal' ? aria : config.orientation;
  };
  const applyRoving = (items, active) => {
    items.forEach((el, i) => { el.tabIndex = i === active ? 0 : -1; });
  };
  const sync = () => {
    if (!root.getAttribute('role')) root.setAttribute('role', role);
    if (config.label) root.setAttribute('aria-label', config.label);
    if (role === 'toolbar' && config.orientation === 'vertical') root.setAttribute('aria-orientation', 'vertical');
    const items = readItems();
    const lastIndex = lastFocusedKey == null ? -1 : items.findIndex((el, i) => keyOf(el, i) === lastFocusedKey);
    const focused = itemFrom(items, root.ownerDocument?.activeElement);
    const active = focused >= 0 ? focused
      : entryFocusIndex({ count: items.length, isSkipped: skipped(items), lastFocused: lastIndex, selected: selectedIndex(items) });
    applyRoving(items, active);
    if (config.restoreKey != null && pendingRestore.has(config.restoreKey)) {
      const key = pendingRestore.get(config.restoreKey);
      pendingRestore.delete(config.restoreKey);
      const doc = root.ownerDocument;
      const current = doc?.activeElement;
      const lost = !current || current === doc.body || current === doc.documentElement || current.isConnected === false;
      const index = items.findIndex((el, i) => keyOf(el, i) === key);
      if (lost && index >= 0) {
        focusAt(items, index);
        return { items, active: index };
      }
    }
    return { items, active };
  };
  const focusAt = (items, index) => {
    applyRoving(items, index);
    lastFocusedKey = keyOf(items[index], index);
    items[index].focus();
  };
  const select = (el, index, event) => {
    if (isAriaDisabled(el) || isNativeDisabled(el)) return;
    const key = keyOf(el, index);
    if (config.restoreKey != null) pendingRestore.set(config.restoreKey, key);
    (config.onSelect || (target => target.click()))(el, index, event);
    if (el.isConnected !== false) return;
    // The click re-rendered the widget at once: focus the same item in the live root.
    if (config.restoreKey != null) pendingRestore.delete(config.restoreKey);
    const liveRoot = config.resolveRoot?.() || root;
    const liveItems = readItems(liveRoot);
    const match = liveItems.findIndex((n, i) => keyOf(n, i) === key);
    const next = match >= 0 ? match : Math.min(index, liveItems.length - 1);
    if (next < 0) return;
    liveItems.forEach((n, i) => { n.tabIndex = i === next ? 0 : -1; });
    lastFocusedKey = keyOf(liveItems[next], next);
    liveItems[next].focus();
    if (liveRoot !== root) bindComposite(liveRoot, { ...options, role });
  };

  const onKeyDown = event => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const items = readItems();
    const current = itemFrom(items, event.target);
    if (current < 0) return;
    const el = items[current];
    if ((event.key === 'Enter' || event.key === ' ') && isAriaDisabled(el)) {
      event.preventDefault();
      return;
    }
    if ((event.key === ' ' || event.key === 'Enter') && role !== 'toolbar' && !isNativeActivator(el)) {
      if (event.key === ' ' || role === 'tablist') {
        select(el, current, event);
        event.preventDefault();
        event.stopPropagation();
      }
      return;
    }
    const intent = compositeKeyIntent(event.key, { orientation: orientation(), direction: config.direction });
    if (!intent) return;
    if (isTextInput(el) && textInputKeepsKey({
      intent, selectionStart: el.selectionStart, selectionEnd: el.selectionEnd,
      valueLength: String(el.value ?? '').length, shiftKey: event.shiftKey,
    })) return;
    const next = nextCompositeIndex({ count: items.length, current, intent, isSkipped: skipped(items), loop: config.loop });
    event.preventDefault();
    event.stopPropagation();
    if (next < 0 || next === current) return;
    focusAt(items, next);
    if (config.selectionFollowsFocus && !isAriaDisabled(items[next])) select(items[next], next, event);
  };
  const onFocusIn = event => {
    const items = readItems();
    const index = itemFrom(items, event.target);
    if (index < 0) return;
    lastFocusedKey = keyOf(items[index], index);
    applyRoving(items, index);
  };
  // aria-disabled does not stop clicks; stop them before the item's handler.
  const onClickCapture = event => {
    const items = readItems();
    const index = itemFrom(items, event.target);
    if (index >= 0 && isAriaDisabled(items[index])) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  root.addEventListener('keydown', onKeyDown);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('click', onClickCapture, true);
  const binding = {
    root,
    role,
    sync: () => sync(),
    update(next) { Object.assign(config, next); },
    /** Focuses an item by index or itemKey value. */
    focusItem(target) {
      const items = readItems();
      const index = typeof target === 'number' ? target : items.findIndex((el, i) => keyOf(el, i) === target);
      if (index >= 0 && index < items.length) focusAt(items, index);
    },
    destroy() {
      root.removeEventListener('keydown', onKeyDown);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('click', onClickCapture, true);
      bindings.delete(root);
    },
  };
  bindings.set(root, binding);
  sync();
  return binding;
}

export const bindToolbar = (root, options = {}) => bindComposite(root, { ...options, role: 'toolbar' });
export const bindRadioGroup = (root, options = {}) => bindComposite(root, { ...options, role: 'radiogroup' });
/** activation 'automatic' (default: arrows select) or 'manual' (Enter/Space select). */
export const bindTabs = (root, { activation = 'automatic', ...options } = {}) =>
  bindComposite(root, { ...options, role: 'tablist', selectionFollowsFocus: activation === 'automatic' });

/**
 * Remembers which composite item had focus before a re-render, and puts focus
 * back on the same item (by itemKey or index) afterwards.
 */
export function focusSnapshot(root, { selector = '[tabindex]', itemKey = null } = {}) {
  const active = root.ownerDocument?.activeElement;
  const items = [...root.querySelectorAll(selector)];
  const index = itemFrom(items, active);
  if (index < 0) return null;
  return { index, key: itemKey ? itemKey(items[index]) : null, selector };
}

export function restoreFocus(root, snapshot, { itemKey = null } = {}) {
  if (!snapshot) return false;
  const items = [...root.querySelectorAll(snapshot.selector)].filter(el => !isHidden(el) && !isNativeDisabled(el));
  if (!items.length) return false;
  let index = itemKey && snapshot.key != null ? items.findIndex(el => itemKey(el) === snapshot.key) : -1;
  if (index < 0) index = Math.min(snapshot.index, items.length - 1);
  items[index].focus();
  return true;
}

/**
 * Keyboard and pointer tooltips for every `selector` trigger under root.
 * The trigger carries its accessible name in aria-label and the tooltip text
 * in data-egd-tooltip (see tooltipContent); render(state) draws the tooltip,
 * with state {openId, instant, trigger, text}. While open, aria-describedby
 * points at `tooltipId` when the text adds something to the name.
 */
export function bindTooltipTriggers(root, {
  controller,
  render = () => {},
  selector = '[data-egd-tooltip]',
  tooltipId = 'egd-tooltip',
  isFocusVisible = el => { try { return el.matches(':focus-visible'); } catch { return true; } },
} = {}) {
  let counter = 0;
  const triggers = new Map();
  const idOf = el => {
    if (!el.getAttribute('data-egd-tooltip-id')) el.setAttribute('data-egd-tooltip-id', `t${++counter}`);
    const id = el.getAttribute('data-egd-tooltip-id');
    triggers.set(id, el);
    return id;
  };
  const triggerFrom = target => {
    for (let node = target; node && node !== root.parentNode; node = node.parentNode) {
      if (node.getAttribute && node.matches?.(selector)) return node;
    }
    return null;
  };
  let described = null;
  const listener = state => {
    if (described) { described.removeAttribute('aria-describedby'); described = null; }
    const trigger = state.openId ? triggers.get(state.openId) : null;
    const text = trigger?.getAttribute('data-egd-tooltip') || '';
    if (trigger && text && text !== trigger.getAttribute('aria-label')) {
      trigger.setAttribute('aria-describedby', tooltipId);
      described = trigger;
    }
    render({ ...state, trigger, text });
  };
  const ctl = controller || createTooltipController();
  const unsubscribe = ctl.subscribe(listener);

  const onFocusIn = event => {
    const trigger = triggerFrom(event.target);
    if (trigger && isFocusVisible(trigger)) ctl.show(idOf(trigger));
  };
  const onFocusOut = event => {
    const trigger = triggerFrom(event.target);
    if (trigger) ctl.hide(idOf(trigger), { immediate: true });
  };
  const onOver = event => {
    const trigger = triggerFrom(event.target);
    if (trigger && !trigger.contains?.(event.relatedTarget)) ctl.show(idOf(trigger));
  };
  const onOut = event => {
    const trigger = triggerFrom(event.target);
    if (trigger && !trigger.contains?.(event.relatedTarget)) ctl.hide(idOf(trigger));
  };
  const onPress = event => {
    if (event.type === 'keydown' && event.key === 'Escape') return;
    const trigger = triggerFrom(event.target);
    if (trigger) ctl.hide(idOf(trigger), { immediate: true });
  };
  // Escape closes the tooltip first and is not passed to the layer below.
  const onDocumentKey = event => {
    if (event.key === 'Escape' && ctl.getState().openId != null && ctl.escape()) event.stopPropagation();
  };
  const doc = root.ownerDocument;
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);
  root.addEventListener('mouseover', onOver);
  root.addEventListener('mouseout', onOut);
  root.addEventListener('pointerdown', onPress);
  root.addEventListener('keydown', onPress);
  doc?.addEventListener('keydown', onDocumentKey, true);
  return {
    controller: ctl,
    destroy() {
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('mouseover', onOver);
      root.removeEventListener('mouseout', onOut);
      root.removeEventListener('pointerdown', onPress);
      root.removeEventListener('keydown', onPress);
      doc?.removeEventListener('keydown', onDocumentKey, true);
      unsubscribe();
      if (described) { described.removeAttribute('aria-describedby'); described = null; }
    },
  };
}
