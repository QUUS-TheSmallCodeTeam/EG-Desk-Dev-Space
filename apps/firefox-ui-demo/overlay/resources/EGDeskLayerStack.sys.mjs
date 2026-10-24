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

// layer = {
//   id?       stable id (e.g. 'board-menu'); a new one is made when missing,
//   kind      short token for tests and QA ('menu', 'minimap', 'fullscreen' …),
//   dismiss(reason, event)  closes the layer's UI; return false to refuse
//             (for example while a confirmation is open). Throwing counts as
//             closed so a broken layer cannot swallow every later Escape,
//   dismissOnEscape         default true; false means Escape is consumed by
//             this layer but nothing under it closes,
//   dismissOnPointerOutside default false,
//   contains(target)        true when a pointer target is inside the layer.
// }
export function createLayerStack({ onChange = null } = {}) {
  let seq = 0;
  let layers = [];
  const claimed = new WeakSet();

  const changed = () => {
    if (typeof onChange !== 'function') return;
    try { onChange(layers.map(publicLayer)); } catch { /* observers never break the stack */ }
  };
  const index = id => layers.findIndex(layer => layer.id === id);
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
    const at = index(layer.id);
    if (at >= 0) {
      layers.splice(at, 1);
      changed();
    }
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
      const layer = layers[layers.length - 1];
      if (!layer) return null;
      const result = close(layer, reason, null);
      return result.dismissed ? publicLayer(layer) : null;
    },
    top: () => publicLayer(layers[layers.length - 1]),
    has: id => index(id) >= 0,
    size: () => layers.length,
    // Bottom to top, ids and kinds only.
    list: () => layers.map(publicLayer),
    clear() {
      if (!layers.length) return;
      layers = [];
      changed();
    },

    handleEscape(event) {
      if (!event || event.key !== 'Escape') return { handled: false, reason: 'not-escape' };
      if (composing(event)) return { handled: false, reason: 'composing' };
      if (event.defaultPrevented) return { handled: false, reason: 'already-handled' };
      const layer = layers[layers.length - 1];
      if (!layer) return { handled: false, reason: 'empty' };
      if (!claim(event)) return { handled: false, reason: 'claimed' };
      consume(event);
      if (!layer.dismissOnEscape) return { handled: true, dismissed: false, id: layer.id, kind: layer.kind, reason: 'blocked' };
      const result = close(layer, 'escape', event);
      return {
        handled: true, dismissed: result.dismissed, id: layer.id, kind: layer.kind,
        reason: result.failed ? 'dismiss-failed' : result.dismissed ? 'dismissed' : 'refused',
      };
    },

    // Pointer-down outside the top layer closes it when it asked for that.
    // `target` is the event target (or any value its contains() understands).
    handlePointerDown(event, target = event?.target) {
      const layer = layers[layers.length - 1];
      if (!layer) return { handled: false, reason: 'empty' };
      if (!layer.dismissOnPointerOutside) return { handled: false, reason: 'not-dismissable' };
      let inside = false;
      try { inside = !!layer.contains?.(target); } catch { inside = false; }
      if (inside) return { handled: false, reason: 'inside' };
      if (!claim(event)) return { handled: false, reason: 'claimed' };
      const result = close(layer, 'pointer-down-outside', event);
      return {
        handled: true, dismissed: result.dismissed, id: layer.id, kind: layer.kind,
        reason: result.failed ? 'dismiss-failed' : result.dismissed ? 'dismissed' : 'refused',
      };
    },
  };
}
