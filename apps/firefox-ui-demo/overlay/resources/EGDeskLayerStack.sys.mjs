// EG-Desk Escape layers (UX-06). One stack for everything Escape can close:
// menus, popovers, the minimap, a peeked Chat, a fullscreen View. Escape
// closes only the top layer, one per key press. Pure: no DOM listeners, no
// storage, no logging; the screen file owns the keydown/pointerdown listener
// and passes the event in.
//
// Adapted from opencove (MIT), Copyright (c) 2026 DeadWaveWave,
// https://github.com/DeadWaveWave/opencove (e10604b9)
//   src/app/renderer/components/ui/overlayLayerRegistry.ts:1-58
//     (newest layer is the top one; an event is claimed once),
//   src/app/renderer/components/ui/DismissableLayer.tsx:105-132
//     (Escape ignored while an IME is composing; pointer-down outside closes
//      only the top layer).
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions: The above copyright
// notice and this permission notice shall be included in all copies or
// substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS IS",
// WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
// TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE
// FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
// TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR
// THE USE OR OTHER DEALINGS IN THE SOFTWARE.

export const LAYER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

const layerKind = value => typeof value === 'string' && KIND_PATTERN.test(value) ? value : 'layer';
const publicLayer = layer => layer ? { id: layer.id, kind: layer.kind } : null;
// keyCode 229 is the key event an IME sends while composing (Korean input).
const composing = event => !!event && (event.isComposing === true || event.keyCode === 229);

// One Escape closes one thing, in this order (UX-06): small menus and lists,
// then a confirmation, then search and panels, then a peeked Chat, and last a
// fullscreen View goes back to its size. Inside a tier the newest closes first.
export const ESCAPE_ORDER = Object.freeze(['menu', 'confirm', 'panel', 'peek', 'fullscreen']);
const KIND_TIER = Object.freeze({
  menu: 'menu', list: 'menu', popover: 'menu', tooltip: 'menu',
  confirm: 'confirm', dialog: 'confirm', modal: 'confirm',
  panel: 'panel', search: 'panel', minimap: 'panel', briefing: 'panel',
  peek: 'peek',
  fullscreen: 'fullscreen', focus: 'fullscreen',
});
const PANEL_RANK = ESCAPE_ORDER.indexOf('panel');
// Lower closes first. An unknown kind is a panel.
export function escapeRank(kind) {
  const tier = typeof kind === 'string' && Object.hasOwn(KIND_TIER, kind) ? KIND_TIER[kind] : null;
  return tier ? ESCAPE_ORDER.indexOf(tier) : PANEL_RANK;
}

// Whether the one screen-wide Escape listener may close the top layer now.
//   phase  'capture' (before the focused element) or 'bubble' (after it),
//   zone   'content' (a page or a terminal owns the key), 'field' (a text
//          field; its own cancel goes first) or 'chrome',
//   fieldEnded  the field is gone or lost focus, so it used this Escape,
//   kind   kind of the top open layer, null when nothing is open,
//   inside the key was pressed inside that layer (its own Escape goes first),
//   repeat the key is being held down.
// Small menus and confirmations close in capture, before anything else sees
// the key. Search, panels, a peeked Chat and a fullscreen View wait for bubble,
// so whatever has focus and handles its own Escape closes first.
export function escapeRoute({
  key, composing: imeComposing = false, defaultPrevented = false, repeat = false,
  phase = 'capture', zone = 'chrome', fieldEnded = false, kind = null, inside = false,
} = {}) {
  const no = reason => ({ act: false, reason });
  if (key !== 'Escape') return no('not-escape');
  if (imeComposing) return no('composing');
  if (zone === 'content') return no('content-owns-key');
  if (kind == null) return no('empty');
  if (defaultPrevented) return no('already-handled');
  if (repeat) return no('held');
  if (phase === 'capture') {
    if (zone === 'field') return no('field-first');
    if (inside) return no('layer-first');
    if (escapeRank(kind) >= PANEL_RANK) return no('after-focused');
  } else if (zone === 'field' && fieldEnded) {
    return no('field-used-key');
  }
  return { act: true, reason: 'top-layer' };
}

// layer = {
//   id?       stable id (e.g. 'board-menu'); a new one is made when missing,
//   kind      short token for tests and QA ('menu', 'minimap', 'fullscreen' …),
//   dismiss(reason, event)  closes the layer's UI; return false to refuse
//             (for example while a confirmation is open). Throwing counts as
//             closed so a broken layer cannot swallow every later Escape,
//   dismissOnEscape         default true; false means Escape is consumed by
//             this layer but nothing under it closes,
//   dismissOnPointerOutside default false,
//   contains(target)        true when a pointer target is inside the layer,
//   isOpen()                optional. A standing layer: registered once, it
//             counts only while isOpen() is true and stays registered after
//             it closes. One that is still open after dismiss() is dropped.
// }
// rank(kind): optional close order, lower first (escapeRank). Without it the
// newest layer is the top one.
export function createLayerStack({ onChange = null, rank = null } = {}) {
  let seq = 0;
  let layers = [];
  const claimed = new WeakSet();

  const changed = () => {
    if (typeof onChange !== 'function') return;
    try { onChange(layers.map(publicLayer)); } catch { /* observers never break the stack */ }
  };
  const index = id => layers.findIndex(layer => layer.id === id);
  const isOpen = layer => {
    if (!layer.isOpen) return true;
    try { return !!layer.isOpen(); } catch { return false; }
  };
  const tier = layer => {
    if (typeof rank !== 'function') return 0;
    try { const value = Number(rank(layer.kind)); return Number.isFinite(value) ? value : 0; } catch { return 0; }
  };
  // The layer Escape closes next: lowest tier, newest inside it.
  const topLayer = () => {
    let best = null;
    let bestTier = Infinity;
    for (let at = layers.length - 1; at >= 0; at -= 1) {
      const layer = layers[at];
      if (!isOpen(layer)) continue;
      const value = tier(layer);
      if (value < bestTier) { best = layer; bestTier = value; }
    }
    return best;
  };
  const drop = layer => {
    const at = index(layer.id);
    if (at < 0) return;
    layers.splice(at, 1);
    changed();
  };
  const outcome = result => result.failed ? 'dismiss-failed' : result.dismissed ? 'dismissed' : result.stillOpen ? 'still-open' : 'refused';
  const claim = event => {
    if (!event || typeof event !== 'object') return true;
    if (claimed.has(event)) return false;
    claimed.add(event);
    return true;
  };
  const consume = event => {
    try { event?.preventDefault?.(); } catch {}
    try { event?.stopPropagation?.(); } catch {}
  };

  function close(layer, reason, event) {
    let result;
    let failed = false;
    try { result = layer.dismiss?.(reason, event); } catch { failed = true; }
    if (result === false && !failed) return { dismissed: false, failed: false };
    if (layer.isOpen && !failed) {
      if (!isOpen(layer)) return { dismissed: true, failed: false };
      drop(layer);
      return { dismissed: false, failed: false, stillOpen: true };
    }
    drop(layer);
    return { dismissed: true, failed };
  }

  return {
    // Adds a layer on top, or moves an already open layer (same id) to the
    // top with its new callbacks. Returns the layer id, or null when invalid.
    push(layer = {}) {
      if (!layer || typeof layer !== 'object') return null;
      let id = layer.id;
      if (id == null) {
        do { seq += 1; id = `layer-${seq}`; } while (index(id) >= 0);
      }
      if (typeof id !== 'string' || !LAYER_ID_PATTERN.test(id)) return null;
      const entry = {
        id, kind: layerKind(layer.kind),
        dismiss: typeof layer.dismiss === 'function' ? layer.dismiss : null,
        dismissOnEscape: layer.dismissOnEscape !== false,
        dismissOnPointerOutside: layer.dismissOnPointerOutside === true,
        contains: typeof layer.contains === 'function' ? layer.contains : null,
        isOpen: typeof layer.isOpen === 'function' ? layer.isOpen : null,
      };
      const at = index(id);
      if (at >= 0) layers.splice(at, 1);
      layers.push(entry);
      changed();
      return id;
    },
    // The UI closed by other means (its own button, its owner went away).
    remove(id) {
      const at = index(id);
      if (at < 0) return false;
      layers.splice(at, 1);
      changed();
      return true;
    },
    // Closes the top layer as Escape would, without an event.
    pop(reason = 'programmatic') {
      const layer = topLayer();
      if (!layer) return null;
      const result = close(layer, reason, null);
      return result.dismissed ? publicLayer(layer) : null;
    },
    top: () => publicLayer(topLayer()),
    // True when `target` is inside the layer Escape would close next.
    topContains(target) {
      const layer = topLayer();
      if (!layer?.contains) return false;
      try { return !!layer.contains(target); } catch { return false; }
    },
    has: id => index(id) >= 0,
    size: () => layers.filter(isOpen).length,
    // Open layers in the order they were added, ids and kinds only.
    list: () => layers.filter(isOpen).map(publicLayer),
    clear() {
      if (!layers.length) return;
      layers = [];
      changed();
    },

    handleEscape(event) {
      if (!event || event.key !== 'Escape') return { handled: false, reason: 'not-escape' };
      if (composing(event)) return { handled: false, reason: 'composing' };
      if (event.defaultPrevented) return { handled: false, reason: 'already-handled' };
      const layer = topLayer();
      if (!layer) return { handled: false, reason: 'empty' };
      if (!claim(event)) return { handled: false, reason: 'claimed' };
      consume(event);
      if (!layer.dismissOnEscape) return { handled: true, dismissed: false, id: layer.id, kind: layer.kind, reason: 'blocked' };
      const result = close(layer, 'escape', event);
      return {
        handled: true, dismissed: result.dismissed, id: layer.id, kind: layer.kind,
        reason: outcome(result),
      };
    },

    // Pointer-down outside the top layer closes it when it asked for that.
    // `target` is the event target (or any value its contains() understands).
    handlePointerDown(event, target = event?.target) {
      const layer = topLayer();
      if (!layer) return { handled: false, reason: 'empty' };
      if (!layer.dismissOnPointerOutside) return { handled: false, reason: 'not-dismissable' };
      let inside = false;
      try { inside = !!layer.contains?.(target); } catch { inside = false; }
      if (inside) return { handled: false, reason: 'inside' };
      if (!claim(event)) return { handled: false, reason: 'claimed' };
      const result = close(layer, 'pointer-down-outside', event);
      return {
        handled: true, dismissed: result.dismissed, id: layer.id, kind: layer.kind,
        reason: outcome(result),
      };
    },
  };
}
