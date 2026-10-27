import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { compileFunction } from 'node:vm';
import { readSurfaceSource } from './egdesk-surface-source.mjs';
import * as SurfaceState from '../overlay/resources/EGDeskSurfaceState.sys.mjs';
import { OBSERVE } from './verify-semantic-zoom.mjs';

const overlay = readSurfaceSource();
const functionSource = name => overlay.match(new RegExp(`  function ${name}\\([^]*?\\n  }`))?.[0];
const production = (name, dependencies = {}) => {
  const source = functionSource(name);
  assert.ok(source, `production ${name} exists`);
  return compileFunction(`${source}; return ${name};`, Object.keys(dependencies))(...Object.values(dependencies));
};

function renderedLevel({ width = 1150.4, zoom = .8, previous = 'outline', metrics,
  cardWidth = 1440, cardHeight = 640, projectedFont, bodyFontPx = 11 } = {}) {
  const start = overlay.indexOf('        const projectedFont =', overlay.indexOf('    const render = () => {', overlay.indexOf('function installSemanticZoom')));
  const end = overlay.indexOf('        if (level !== entry.level)', start);
  assert.ok(start > 0 && end > start);
  return compileFunction(`${overlay.slice(start, end)}\nreturn level;`,
    ['entry', 'card', 'rect', 'zoom', 'SurfaceState', 'isCardFullscreen', 'detailWidth', 'detailHeight'])(
    { kind: 'browser', bodyFontPx, level: previous },
    { _browserPresentation: { font: () => projectedFont === undefined
      ? production('browserPresentationFont')(metrics, width) : projectedFont } },
    { width: cardWidth * zoom, height: cardHeight * zoom }, zoom, SurfaceState, () => false, 240, 180);
}
const metric = Object.freeze({ version: 1, complete: true, fontPx: 16,
  viewportWidth: 1440, viewportHeight: 573, sampleCount: 8 });

function outlineDragHarness({ zoom = .25, pan = { x: 110, y: -65 }, level = 'outline', blurOnActivate = false } = {}) {
  const target = () => {
    const listeners = new Map();
    const captures = new Map();
    let captured = null;
    return { listeners,
      get captured() { return captured; },
      setPointerCapture(id) { captured = id; },
      hasPointerCapture(id) { return captured === id; },
      releasePointerCapture(id) { assert.equal(captured, id); captured = null; },
      addEventListener(type, fn, capture = false) { listeners.set(type, fn); captures.set(type, capture); },
      removeEventListener(type, fn, capture = false) {
        if (listeners.get(type) !== fn) return;
        assert.equal(capture, captures.get(type), `${type} removal must match registration capture`);
        listeners.delete(type); captures.delete(type);
      },
      fire(type, data = {}) {
        const ev = { type, target: this, button: 0, buttons: 1, isPrimary: true, pointerId: type === 'blur' ? undefined : 7, detail: 1,
          clientX: 150, clientY: -20, preventDefault() { this.prevented = true; },
          stopPropagation() { this.stopped = true; }, ...data };
        listeners.get(type)?.(ev); return ev;
      } };
  };
  const window = target(), proxy = target();
  const state = { zoom, pan: { ...pan }, zoomTarget: zoom, panTarget: { ...pan }, panModifier: false };
  const resource = Object.freeze({ uri: 'https://example.test/', context: 12, fullZoom: 1 });
  const card = { isConnected: true, style: { left: '80px', top: '120px', width: '448px', height: '343px' }, _browser: resource };
  const entry = { card, proxy, level };
  let focused = 0, activated = 0, saved = 0, rendered = 0;
  const dispose = production('installSemanticOutlineDrag', { state, window,
    parsePxNumber: (value, fallback) => Number.parseFloat(value) || fallback || 0,
    isCardFullscreen: () => false, focusCanvasCard: () => {
      activated++;
      if (blurOnActivate) window.fire('blur', { target: proxy });
    },
    markAgendaDirty(reason, node) { assert.equal(reason, 'move-outline-card'); assert.equal(node, card); saved++; },
  })(entry, { focusProjection: item => { assert.equal(item, entry); focused++; }, request: () => { rendered++; } });
  return { window, proxy, state, card, entry, resource, dispose,
    get focused() { return focused; }, get activated() { return activated; },
    get saved() { return saved; }, get rendered() { return rendered; } };
}

test('outline proxy is wired to direct dragging and releases its listeners on removal', () => {
  assert.match(overlay, /entry\.disposeOutlineDrag = installSemanticOutlineDrag\(entry, \{ focusProjection, request \}\)/);
  assert.match(overlay, /const remove = card => \{[^]*?entry\.disposeOutlineDrag\(\)/);
  const h = outlineDragHarness();
  h.proxy.fire('pointerdown'); h.dispose();
  assert.equal(h.window.listeners.size, 0); assert.equal(h.proxy.listeners.size, 0);
  assert.equal(h.saved, 0);
});

test('outline drag uses a 4px screen threshold and inverse camera transform, never readable focus', () => {
  for (const zoom of [.2, .25, .5]) {
    const h = outlineDragHarness({ zoom });
    const before = JSON.stringify(h.state), dimensions = [h.card.style.width, h.card.style.height];
    h.proxy.fire('pointerdown');
    assert.equal(h.proxy.captured, 7);
    h.window.fire('pointermove', { clientX: 153.99 });
    assert.equal(h.card.style.left, '80px', 'sub-threshold motion does not move the Card');
    h.window.fire('pointermove', { clientX: 154 });
    assert.equal(Number.parseFloat(h.card.style.left), 80 + 4 / zoom);
    h.window.fire('pointermove', { clientX: 174, clientY: -10 });
    assert.ok(Math.abs(Number.parseFloat(h.card.style.left) - (80 + 24 / zoom)) < 1e-9);
    assert.ok(Math.abs(Number.parseFloat(h.card.style.top) - (120 + 10 / zoom)) < 1e-9);
    h.window.fire('mouseup'); // compatibility release must terminate the pointer path too
    assert.equal(h.proxy.captured, null);
    assert.equal(h.proxy.fire('click').prevented, true, 'post-drag click cannot zoom');
    const position = JSON.stringify(h.card.style);
    h.window.fire('pointermove', { clientX: 600 });
    assert.equal(JSON.stringify(h.card.style), position);
    assert.equal(h.window.listeners.size, 0);
    assert.equal(h.saved, 1); assert.equal(h.activated, 1); assert.equal(h.focused, 0);
    assert.equal(JSON.stringify(h.state), before, 'no pan, zoom, target or camera history change');
    assert.deepEqual([h.card.style.width, h.card.style.height], dimensions);
    assert.equal(h.entry.level, 'outline', 'drag never resets semantic hysteresis');
    assert.equal(h.card._browser, h.resource);
  }
});

test('outline click jitter and keyboard activation still focus, while pointercancel suppresses click and cleans up', () => {
  const h = outlineDragHarness();
  h.proxy.fire('pointerdown'); h.window.fire('pointermove', { clientX: 152, clientY: -18 });
  h.window.fire('pointerup'); h.proxy.fire('click');
  assert.equal(h.focused, 1); assert.equal(h.saved, 0);
  h.proxy.fire('pointerdown'); h.window.fire('pointermove', { clientX: 180 });
  h.window.fire('pointercancel', { pointerId: 8 });
  assert.ok(h.window.listeners.size, 'unrelated pointer cancellation does not steal the gesture');
  h.window.fire('pointercancel'); h.proxy.fire('click'); h.window.fire('mouseup');
  assert.equal(h.focused, 1); assert.equal(h.saved, 1); assert.equal(h.window.listeners.size, 0);
  h.proxy.fire('click', { detail: 0 });
  assert.equal(h.focused, 2, 'keyboard activation is not swallowed after a cancelled drag');
  h.proxy.fire('pointerdown'); h.window.fire('mouseup'); h.proxy.fire('click');
  assert.equal(h.focused, 3, 'next ordinary click is not stale-suppressed');
});

test('outline first drag survives internal proxy/input blur, including synchronous activation blur', () => {
  for (const kind of ['proxy', 'input', 'activation']) {
    const h = outlineDragHarness({ blurOnActivate: kind === 'activation' });
    const camera = JSON.stringify(h.state);
    h.proxy.fire('pointerdown');
    if (kind !== 'activation') h.window.fire('blur', { target: kind === 'proxy' ? h.proxy : { tagName: 'TEXTAREA' } });
    assert.equal(h.proxy.captured, 7, 'internal focus movement must keep pending capture');
    assert.ok(h.window.listeners.has('pointermove'));
    h.window.fire('pointermove', { clientX: 210, clientY: 16 });
    assert.equal(Number.parseFloat(h.card.style.left) - 80, 240, 'first drag, no retry');
    assert.equal(Number.parseFloat(h.card.style.top) - 120, 144);
    assert.equal(h.proxy.captured, 7);
    h.window.fire('mouseup'); h.proxy.fire('click');
    assert.equal(h.saved, 1); assert.equal(h.focused, 0);
    assert.equal(h.proxy.captured, null); assert.equal(h.window.listeners.size, 0);
    assert.equal(JSON.stringify(h.state), camera);
    assert.equal(h.card._browser, h.resource);
  }
});

test('outline actual window blur cancels before or after movement and releases matching listeners', () => {
  for (const moved of [false, true]) {
    const h = outlineDragHarness(); h.proxy.fire('pointerdown');
    if (moved) h.window.fire('pointermove', { clientX: 160 });
    const position = JSON.stringify(h.card.style);
    h.window.fire('blur', { target: h.window });
    assert.equal(h.window.listeners.size, 0); assert.equal(h.proxy.captured, null);
    h.window.fire('pointermove', { clientX: 210 }); h.window.fire('mouseup'); h.proxy.fire('click');
    assert.equal(JSON.stringify(h.card.style), position);
    assert.equal(h.saved, moved ? 1 : 0); assert.equal(h.focused, 0);
  }
});

test('outline drag cancels on lost buttons/capture, blur, LOD change or removal and preserves marker behavior', () => {
  for (const stop of ['buttons', 'capture', 'blur', 'lod', 'removed']) {
    const h = outlineDragHarness(); h.proxy.fire('pointerdown');
    h.window.fire('pointermove', { clientX: 160 });
    const before = JSON.stringify(h.card.style);
    if (stop === 'lod') h.entry.level = 'marker';
    if (stop === 'removed') h.card.isConnected = false;
    if (stop === 'capture') h.proxy.fire('lostpointercapture');
    else if (stop === 'blur') h.window.fire('blur');
    else h.window.fire('pointermove', { clientX: 190, buttons: stop === 'buttons' ? 0 : 1 });
    h.proxy.fire('click');
    assert.equal(h.focused, 0, stop); assert.equal(h.window.listeners.size, 0, stop);
    assert.equal(JSON.stringify(h.card.style), before, stop);
  }
  for (const changed of [{ level: 'marker' }, { level: 'detail' }, { pan: true }, { button: 2 }, { isPrimary: false }]) {
    const h = outlineDragHarness({ level: changed.level || 'outline' });
    h.state.panModifier = !!changed.pan; h.proxy.fire('pointerdown', changed);
    assert.equal(h.window.listeners.size, 0);
    assert.equal(h.card.style.left, '80px');
    if (changed.level === 'marker') { h.proxy.fire('click'); assert.equal(h.focused, 1); }
  }
});

test('outline dragging keeps the original grab point even if the camera transform changes externally', () => {
  const h = outlineDragHarness();
  h.proxy.fire('pointerdown');
  const grab = { x: (150 - 110) / .25 - 80, y: (-20 + 65) / .25 - 120 };
  h.state.zoom = .3; h.state.pan = { x: 120, y: -40 };
  h.window.fire('pointermove', { clientX: 170, clientY: -5 });
  assert.ok(Math.abs((Number.parseFloat(h.card.style.left) + grab.x) * .3 + 120 - 170) < 1e-9);
  assert.ok(Math.abs((Number.parseFloat(h.card.style.top) + grab.y) * .3 - 40 + 5) < 1e-9);
  assert.equal(h.state.zoom, .3); assert.deepEqual(h.state.pan, { x: 120, y: -40 });
  h.window.fire('pointerup');
});

test('actual Browser render delays semantic zoom with measured or fallback fonts', () => {
  assert.equal(renderedLevel({ metrics: metric }), 'detail');
  assert.equal(renderedLevel({ width: 1078.5, zoom: .75, metrics: metric }), 'detail');
  assert.equal(renderedLevel({ width: 1440 * .69, zoom: .69, previous: 'outline', metrics: metric }), 'detail');
  assert.equal(renderedLevel({ width: 1440 * .5, zoom: .5, previous: 'outline', metrics: metric }), 'detail');
  assert.equal(renderedLevel({ width: 1440 * .5 * .9, zoom: .5, previous: 'outline', metrics: { ...metric, fontPx: 12 } }), 'detail',
    '12px content fitted to 90% still appears at 50% Desk zoom');
  assert.equal(renderedLevel({ width: 766.4, previous: 'detail', metrics: metric }), 'detail');
  assert.equal(renderedLevel({ width: 431.4, zoom: .3, metrics: metric }), 'detail');
  assert.equal(renderedLevel({ width: 1440 * .2, zoom: .2, metrics: metric }), 'outline');
  for (const zoom of [.69, .5, .35, .3]) {
    assert.equal(renderedLevel({ width: 1440 * zoom, zoom, previous: 'outline' }), 'detail',
      `the fallback font also retains ordinary Browser detail at ${zoom}`);
  }
});

test('Browser content metric validates evidence and applies the actual width ratio exactly once', () => {
  const font = production('browserPresentationFont');
  assert.equal(font(metric, 1150.4), 16 * 1150.4 / 1440);
  assert.equal(font(metric, 766.4), 16 * 766.4 / 1440);
  for (const changed of [{ complete: false }, { version: 2 }, { fontPx: null }, { fontPx: '16' },
    { fontPx: NaN }, { fontPx: Infinity }, { fontPx: 0 }, { sampleCount: 0 }, { sampleCount: 65 },
    { viewportWidth: 0 }, { viewportHeight: Infinity }]) {
    assert.equal(font({ ...metric, ...changed }, 1150.4), null, JSON.stringify(changed));
  }
  assert.equal(font(null, 1150.4), null, 'no fabricated body font');
  assert.equal(font(metric, 0), null);
});

test('native 448x343 Browser retains detail despite tiny text from its fixed 1440px page fit', () => {
  const card = { cardWidth: 448, cardHeight: 343 };
  for (const previous of ['outline', 'detail']) {
    for (const zoom of [1, .69, .5, .35, .3]) {
      assert.equal(renderedLevel({ ...card, zoom, previous, projectedFont: 4.02594 * zoom }), 'detail',
        `native small card at ${zoom} from ${previous}`);
    }
    assert.equal(renderedLevel({ ...card, zoom: .25, previous, projectedFont: 4.02594 * .25 }), 'outline',
      `deep zoom still abstracts from ${previous}`);
    assert.equal(renderedLevel({ ...card, zoom: .1, previous, projectedFont: 4.02594 * .1 }), 'marker');
    assert.equal(renderedLevel({ ...card, zoom: .17, previous, projectedFont: 20 }), 'marker',
      'large page text cannot bypass the original small projected geometry');
  }
});

test('Browser semantic font floor retains common hysteresis below nominal readability', () => {
  assert.equal(renderedLevel({ zoom: .28, projectedFont: 3.1, previous: 'detail' }), 'detail');
  assert.equal(renderedLevel({ zoom: .28, projectedFont: 3.1, previous: 'outline' }), 'outline');
  assert.equal(renderedLevel({ zoom: .28, projectedFont: 3.4, previous: 'outline' }), 'detail',
    'larger measured text can still supply detail above the nominal floor');
  assert.equal(renderedLevel({ zoom: .26, projectedFont: 2.8, previous: 'detail' }), 'outline',
    'the common exit font floor still applies even with ample projected geometry');
});

test('Browser LOD rejects invalid projected font evidence and retains invalid geometry guards', () => {
  for (const projectedFont of [null, NaN, Infinity, -Infinity, 0, -1, '16']) {
    assert.equal(renderedLevel({ zoom: .5, projectedFont }), 'detail', 'nominal fallback at ordinary zoom');
    assert.equal(renderedLevel({ zoom: .25, projectedFont }), 'outline', 'fallback still scales with the camera');
  }
  for (const invalid of [NaN, Infinity, 0, -1]) {
    assert.equal(renderedLevel({ cardWidth: invalid, projectedFont: 20 }), 'marker');
    assert.equal(renderedLevel({ cardHeight: invalid, projectedFont: 20 }), 'marker');
  }
});

test('explicit Browser focus keeps raw measured page font instead of the LOD-only nominal floor', () => {
  const start = overlay.indexOf('      const zoomFor = region => {', overlay.indexOf('    const focusProjection ='));
  const end = overlay.indexOf('      let zoom = zoomFor(safe);', start);
  assert.ok(start > 0 && end > start, 'production focus-to-readable zoom calculation');
  const zoomFor = compileFunction(`${overlay.slice(start, end)}\nreturn zoomFor;`,
    ['SurfaceState', 'world', 'entry', 'state', 'ZOOM_MAX', 'detailWidth', 'detailHeight', 'focusWidth']);
  const world = { x: 0, y: 0, width: 448, height: 343 };
  const region = { left: 0, top: 0, width: 1200, height: 800 };
  for (const zoom of [1, .69, .5]) {
    const measured = 4.02594 * zoom;
    const card = { _browserPresentation: { font: () => measured } };
    const focus = zoomFor(SurfaceState, world, { kind: 'browser', card, bodyFontPx: 11 }, { zoom }, 4, 240, 180, world.width);
    assert.ok(Math.abs(focus(region) - 10.6 / 4.02594) < 1e-9, `raw page font at ${zoom}`);
    assert.equal(card._browserPresentation.font(), measured, 'the LOD floor does not replace cached evidence');
  }
  for (const measured of [null, NaN, Infinity, 0, -1, '4']) {
    const card = { _browserPresentation: { font: () => measured } };
    const focus = zoomFor(SurfaceState, world, { kind: 'browser', card, bodyFontPx: 11 }, { zoom: .5 }, 4, 240, 180, world.width);
    assert.equal(focus(region), 10.6 / 11, 'invalid evidence retains the existing nominal focus fallback');
  }
});

test('native small Browser focus at 35% uses uninflated fit, keeps toolbar reachable, and preserves the View', () => {
  const fitStart = overlay.indexOf('    let logicalHeight = 0, lastCardSize');
  const fitEnd = overlay.indexOf('    deskWindow.onResize(updateFitScale);', fitStart);
  const focusSource = overlay.match(/    const focusProjection = \(entry, \{ revealHeader = false \} = \{\}\) => \{([^]*?)\n    \};/)?.[1];
  assert.ok(fitStart > 0 && fitEnd > fitStart && focusSource, 'compile the actual layout and complete focus function');
  let zoom = 1, inverse = 1, target = null, focused = null;
  let evidence = { ...metric, fontPx: 13, viewportHeight: 888 };
  const world = { x: 155, y: 130, width: 448, height: 343 };
  const style = { left: '155px', top: '130px', width: '448px', height: '343px' };
  const browser = Object.freeze({ context: 15, innerWindowId: 17179869185, fullZoom: 1, textZoom: 1 });
  const card = { isConnected: true, style, clientWidth: 448, clientHeight: 343, offsetWidth: 450, offsetHeight: 345,
    setAttribute() {}, _browser: browser };
  const header = { get offsetHeight() { return 67 * inverse; }, style: {
    setProperty(key, value) { assert.equal(key, '--egd-browser-ui-scale'); inverse = Number(value); },
  } };
  const body = { clientWidth: 448, get clientHeight() { return card.clientHeight - header.offsetHeight - 1; } };
  const wrap = { style: {} };
  const presentation = { read: () => evidence, invalidate() {}, font: () => .773680665757921 };
  card._browserPresentation = presentation;
  const update = compileFunction(`${overlay.slice(fitStart, fitEnd)}; return updateFitScale;`,
    ['body', 'card', 'header', 'wrap', 'options', 'presentation', 'agentProjection', 'CARD_LOGICAL_W', 'canvasZoom', 'browserPresentationFit', 'browserPresentationFont'])(
    body, card, header, wrap, {}, presentation, { invalidate() {} }, 1440, () => zoom,
    production('browserPresentationFit'), production('browserPresentationFont'));
  update();
  assert.equal(wrap.style.height, '888px', 'the existing real-size layout establishes the logical page height');
  const nominal = presentation.nominalWorldFont();
  assert.ok(Math.abs(nominal - 4.02594) < .001, '13px page font at the uninflated real Card fit');
  zoom = .35; update();
  assert.equal(presentation.nominalWorldFont(), nominal, 'compact toolbar fit cannot shrink the focus font');
  const snapshot = JSON.stringify({ style, wrap: wrap.style, browser });
  const state = { zoom, pan: { x: 390, y: 227.5 }, setCanvasViewportTarget(value) { target = value; } };
  // 1280x820 native viewport: allow the flush topbar, floating rail, dock and margins.
  let safe = { left: 102, top: 76, right: 1256, bottom: 738, width: 1154, height: 662 };
  const focus = compileFunction(`return (entry, { revealHeader = false } = {}) => {${focusSource}\n};`,
    ['state', 'authorVisible', 'screenRect', 'safeViewportRect', 'SurfaceState', 'ZOOM_MAX', 'detailWidth', 'detailHeight',
      'focusCanvasCard', 'visibleChatZoomRect', 'window', 'parsePxNumber', 'CHAT_ZOOM_GAP'])(
    state, () => true, () => ({ visualWorld: world }), () => safe, SurfaceState, 4, 240, 180,
    value => { focused = value; }, () => null, { getComputedStyle: () => ({ boxSizing: 'border-box' }) }, () => 0, 10);
  const entry = { card, kind: 'browser', bodyFontPx: 11 };
  focus(entry);
  assert.equal(focused, card, 'same View receives focus');
  assert.equal(card._browser, browser, 'same mounted browser/context');
  assert.equal(JSON.stringify({ style, wrap: wrap.style, browser }), snapshot,
    'focus does not write world geometry, logical viewport, fit, page zoom or browser identity');
  assert.equal(target.zoom, safe.width / card.offsetWidth);
  assert.ok(target.zoom > 2 && target.zoom < 3, 'sensible reading zoom, not the observed 400%');
  const left = world.x * target.zoom + target.pan.x;
  const top = world.y * target.zoom + target.pan.y;
  assert.equal(left, safe.left, 'height-cropped Browser anchors its left content');
  assert.equal(top, safe.top, 'height-cropped Browser anchors its header');
  assert.ok(left + card.offsetWidth * target.zoom <= safe.right + 1e-9, 'right toolbar edge remains accessible');
  assert.ok(top + 67 * target.zoom <= safe.bottom, 'both header/navigation rows remain accessible');
  assert.ok(nominal * target.zoom < 10.6, 'width-limited focus does not falsely promise the reading target');
  assert.ok(nominal * target.zoom > 10, 'record the actual approximately 10.32px projection');
  safe = { left: 0, top: 0, right: 1280, bottom: 820, width: 1280, height: 820 };
  focus(entry);
  assert.ok(Math.abs(target.zoom - 10.6 / nominal) < 1e-9, 'real page font reaches the reading target when width permits');
  assert.ok(target.pan.x + world.x * target.zoom >= safe.left);
  assert.ok(target.pan.x + (world.x + card.offsetWidth) * target.zoom <= safe.right);
  for (const kind of ['file', 'chat']) {
    focus({ ...entry, kind });
    assert.equal(target.zoom, 10.6 / 11, `${kind} keeps its existing reading policy`);
    assert.ok(target.pan.y + world.y * target.zoom > safe.top, `${kind} keeps its existing centered placement`);
  }
  evidence = null;
  assert.equal(presentation.nominalWorldFont(), null, 'missing or stale cache cannot fabricate a nominal page font');
});

test('Browser font metrics are requested throughout the common detail geometry band', () => {
  const mayNeedMetrics = production('browserPresentationMayNeedMetrics', { SurfaceState });
  const boundary = { width: 240 * .42 * .88, height: 180 * .42 * .88, detailWidth: 240, detailHeight: 180 };
  assert.equal(mayNeedMetrics(boundary), true);
  assert.equal(mayNeedMetrics({ ...boundary, width: boundary.width - .01 }), false);
  assert.equal(mayNeedMetrics({ ...boundary, height: boundary.height - .01 }), false);
  assert.equal(mayNeedMetrics({ ...boundary, width: NaN }), false);
});

function cacheHarness() {
  let time = 0, next = 0, changed = 0, calls = 0, width = 1150.4;
  const timers = new Map(), replies = [];
  const card = { isConnected: true };
  const browser = { isConnected: true, fullZoom: 1,
    browsingContext: { currentWindowGlobal: {} }, getBoundingClientRect: () => ({ width }) };
  const create = production('createBrowserPresentationCache', { browserPresentationFont: production('browserPresentationFont') });
  const cache = create({ card, browser, now: () => time,
    setTimer(fn, ms) { const id = ++next; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimer(id) { timers.delete(id); }, changed: () => { changed += 1; },
    query: () => { calls += 1; return new Promise((resolve, reject) => replies.push({ resolve, reject })); },
  });
  const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
  return { card, browser, cache, replies, timers, flush,
    get calls() { return calls; }, get changed() { return changed; },
    setWidth(value) { width = value; },
    elapseWithoutTimers(ms) { time += ms; },
    async advance(ms) {
      time += ms;
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.fn(); }
      await flush();
    },
  };
}

test('presentation cache coalesces and reuses measured fonts for ordinary Desk camera frames', async () => {
  const h = cacheHarness();
  for (let i = 0; i < 120; i++) h.cache.ensure();
  assert.equal(h.timers.size, 1);
  await h.advance(80);
  assert.equal(h.calls, 1);
  h.replies[0].resolve(metric); await h.flush();
  assert.equal(h.cache.font(), 16 * 1150.4 / 1440);
  h.setWidth(1078.5);
  for (let i = 0; i < 120; i++) h.cache.ensure();
  assert.equal(h.cache.font(), 16 * 1078.5 / 1440);
  assert.equal(h.calls, 1, 'camera zoom does not resample the document');
  assert.equal(h.timers.size, 0);
  await h.advance(30001);
  assert.equal(h.cache.font(), null, 'stale evidence is not used indefinitely');
  assert.equal(h.calls, 1, 'no background polling when no candidate asks');
  h.cache.ensure(); await h.advance(80);
  assert.equal(h.calls, 2);
});

test('incomplete, rejected and timed-out metrics never create an outline/detail retry loop', async () => {
  for (const failure of ['incomplete', 'reject', 'timeout']) {
    const h = cacheHarness();
    h.cache.ensure(); await h.advance(80);
    if (failure === 'incomplete') h.replies[0].resolve({ ...metric, complete: false, fontPx: null });
    if (failure === 'reject') h.replies[0].reject(new Error('unavailable'));
    if (failure === 'timeout') await h.advance(1200);
    await h.flush();
    for (let i = 0; i < 120; i++) h.cache.ensure();
    assert.equal(h.cache.font(), null);
    assert.equal(h.calls, 1);
    assert.equal(h.changed, 1);
    if (failure === 'timeout') {
      h.replies[0].resolve(metric); await h.flush();
      assert.equal(h.cache.font(), null, 'late success cannot resurrect expired evidence');
      assert.equal(h.changed, 1);
    }
    h.cache.dispose();
    assert.equal(h.timers.size, 0);
  }
});

test('unsettled timeout releases its slot so a new document recovers before the old reply', async () => {
  const h = cacheHarness();
  h.cache.ensure(); await h.advance(80);
  await h.advance(1200);
  assert.equal(h.cache.diagnostics().pending, false, 'timeout releases the active slot even without a reply');
  h.browser.browsingContext.currentWindowGlobal = {};
  h.cache.invalidate();
  h.cache.ensure(); await h.advance(80);
  assert.equal(h.calls, 2, 'new document does not wait forever on the previous document');
  h.replies[0].resolve(metric); await h.flush();
  assert.equal(h.cache.font(), null, 'expired reply cannot populate the new document cache');
  assert.equal(h.cache.diagnostics().pending, true, 'old finally cannot clear the new flight');
  h.replies[1].resolve({ ...metric, fontPx: 12 }); await h.flush();
  assert.equal(h.cache.font(), 12 * 1150.4 / 1440);
  assert.equal(h.cache.diagnostics().pending, false);
  h.cache.dispose();
  assert.equal(h.timers.size, 0);
});

test('same-document timeout retries only after cooldown and ignores the older reply after success', async () => {
  const h = cacheHarness();
  h.cache.ensure(); await h.advance(80);
  await h.advance(1200);
  for (let i = 0; i < 120; i++) h.cache.ensure();
  assert.equal(h.calls, 1);
  await h.advance(30001);
  h.cache.ensure(); await h.advance(80);
  assert.equal(h.calls, 2);
  h.replies[1].resolve({ ...metric, fontPx: 12 }); await h.flush();
  const settledChanges = h.changed;
  h.replies[0].resolve(metric); await h.flush();
  assert.equal(h.cache.font(), 12 * 1150.4 / 1440);
  assert.equal(h.changed, settledChanges);
  h.cache.dispose();
});

test('a late reply cannot beat a delayed timeout callback and claim fresh presentation evidence', async () => {
  const h = cacheHarness();
  h.cache.ensure(); await h.advance(80);
  h.elapseWithoutTimers(1200);
  h.replies[0].resolve(metric); await h.flush();
  assert.equal(h.cache.font(), null);
  assert.equal(h.cache.diagnostics().pending, false);
  assert.equal(h.changed, 1);
  assert.equal(h.timers.size, 0);
  h.cache.dispose();
});

test('document, page zoom, invalidation and disconnected Card discard stale numeric replies', async () => {
  for (const mutate of [h => { h.browser.browsingContext.currentWindowGlobal = {}; },
    h => { h.browser.browsingContext = { currentWindowGlobal: {} }; },
    h => { h.browser.fullZoom = 1.2; }, h => h.cache.invalidate(),
    h => { h.card.isConnected = false; }, h => h.cache.dispose()]) {
    const h = cacheHarness();
    h.cache.ensure(); await h.advance(80);
    mutate(h);
    h.replies[0].resolve(metric); await h.flush();
    assert.equal(h.cache.font(), null);
    h.cache.dispose();
    assert.equal(h.timers.size, 0);
  }
  const h = cacheHarness();
  h.cache.ensure(); await h.advance(80);
  h.replies[0].resolve(metric); await h.flush();
  h.browser.fullZoom = 1.25;
  assert.equal(h.cache.font(), null);
  h.cache.ensure(); await h.advance(80);
  assert.equal(h.calls, 2, 'real page zoom invalidates immediately, unlike Desk zoom');
  h.cache.dispose();
});

test('Browser fit keeps the same logical viewport below screen-readable controls', () => {
  const fit = production('browserPresentationFit');
  for (const zoom of [1, .8, .75, .83, .3, .01, 1]) {
    const logical = { logicalWidth: 1440, logicalHeight: 573 };
    const height = Math.max(0, 640 - 67 * Math.max(1, 1 / zoom));
    const result = fit({ width: 1440, height, ...logical });
    assert.ok(result.scale >= 0);
    assert.ok(1440 * result.scale <= 1438 + 1e-9);
    assert.ok(573 * result.scale <= height + 1e-9);
    assert.deepEqual(logical, { logicalWidth: 1440, logicalHeight: 573 });
    if (zoom === .8 || zoom === .75) assert.ok(16 * result.scale * zoom >= 10.5);
  }
});

test('production fit/layout preserves page viewport through all camera levels and resizes only with the Card', () => {
  const start = overlay.indexOf('    let logicalHeight = 0, lastCardSize');
  const end = overlay.indexOf('    deskWindow.onResize(updateFitScale);', start);
  assert.ok(start > 0 && end > start);
  let zoom = 1, inverse = 1, invalidations = 0, targetInvalidations = 0;
  const world = { left: '0px', top: '0px', width: '1440px', height: '640px' };
  const card = { clientWidth: 1440, clientHeight: 640, style: world, setAttribute() {} };
  const header = { get offsetHeight() { return 67 * inverse; }, style: {
    setProperty(key, value) { assert.equal(key, '--egd-browser-ui-scale'); inverse = Number(value); },
  } };
  const body = { get clientWidth() { return card.clientWidth; },
    get clientHeight() { return Math.max(0, card.clientHeight - header.offsetHeight); } };
  const wrap = { style: {} };
  const presentation = { invalidate() { invalidations += 1; } };
  const agentProjection = { invalidate() { targetInvalidations += 1; } };
  const update = compileFunction(`${overlay.slice(start, end)}; return updateFitScale;`,
    ['body', 'card', 'header', 'wrap', 'options', 'presentation', 'agentProjection', 'CARD_LOGICAL_W', 'canvasZoom', 'browserPresentationFit'])(
    body, card, header, wrap, {}, presentation, agentProjection, 1440, () => zoom, production('browserPresentationFit'));
  update();
  assert.equal(targetInvalidations, 1, 'initial Card layout invalidates old target display');
  const initialViewport = wrap.style.height;
  assert.equal(initialViewport, '574px');
  for (const next of [.8, .75, .83, .3, .01, 4, 1]) {
    zoom = next; update();
    assert.equal(wrap.style.height, initialViewport, `page viewport preserved at ${zoom}`);
    assert.equal(invalidations, 1, 'no font IPC invalidation for camera-only changes');
    assert.equal(targetInvalidations, 1, 'camera-only changes preserve the approved target projection');
    assert.ok(Number.parseFloat(wrap.style.transform.slice(6)) >= 0);
    assert.deepEqual(world, { left: '0px', top: '0px', width: '1440px', height: '640px' });
    if (zoom >= .75 && zoom <= 1) {
      assert.equal(32 * inverse * zoom, 32, 'both rows retain 32 screen px controls');
      assert.equal(11 * inverse * zoom, 11, 'title font retains screen size');
    }
  }
  assert.ok(Number.parseFloat(wrap.style.transform.slice(6)) > .9, 'recovers after a zero-height compact body');
  card.clientWidth = 960;
  update();
  assert.notEqual(wrap.style.height, initialViewport, 'real Card resize retains responsive page behavior');
  assert.equal(invalidations, 2);
  assert.equal(targetInvalidations, 2, 'real Card width resize invalidates target display');
  card.clientHeight += 80;
  update();
  assert.equal(targetInvalidations, 3, 'real Card height resize invalidates target display');
  zoom = .3;
  update();
  assert.equal(targetInvalidations, 3, 'camera zoom after resize still does not invalidate target display');
});

test('Browser-only readable chrome CSS keeps two rows and 32px controls without changing other Card types', () => {
  const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
  const start = css.indexOf('/* Cancel Desk shrink only');
  const end = css.indexOf('\n.egd-card-progress {', start);
  const rules = css.slice(start, end);
  assert.ok(start > 0 && end > start);
  for (const selector of rules.matchAll(/([^{}]+)\{/g)) {
    const clean = selector[1].replace(/\/\*[^]*?\*\//g, '').trim();
    for (const part of clean.split(',')) assert.match(part.trim(), /^\.egd-browser-card\[data-egd-browser-presentation\]/);
  }
  assert.match(rules, /height: calc\(32px \* var\(--egd-browser-ui-scale\)\)/);
  assert.match(rules, /font-size: calc\(11px \* var\(--egd-browser-ui-scale\)\)/);
  assert.match(rules, /font-size: calc\(12px \* var\(--egd-browser-ui-scale\)\)/);
  assert.doesNotMatch(rules, /position:\s*fixed|z-index:|\.egd-chat|\.egd-terminal/);
});

test('Browser north resize strip preserves its thickness without masking any 32px control grid point', () => {
  const css = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');
  const base = css.match(/^\.egd-card-resize-hit-n\s*\{([^}]+)\}/m)[1];
  const override = css.match(/\.egd-browser-card\[data-egd-browser-presentation\]\s*>\s*\.egd-card-resize-hit-n\s*\{([^}]+)\}/)?.[1] || '';
  const px = (rule, key) => Number(rule.match(new RegExp(`(?:^|;)\\s*${key}:\\s*(-?[\\d.]+)px`))?.[1]);
  const baseTop = px(base, 'top'), height = px(base, 'height');
  const top = /top:/.test(override) ? px(override, 'top') : baseTop;
  const hits = (left, stripTop) => {
    let count = 0;
    for (const fy of [.2, .5, .8]) for (const fx of [.2, .5, .8]) {
      // Main's actual 1800x1000 observation: card padding origin 181,97;
      // close [190,96.5,32,32], maximize [256,96.5,32,32].
      const x = left + 32 * fx, y = 96.5 + 32 * fy;
      const masked = x >= 181 + 16 && x < 181 + 1440 - 16 &&
        y >= 97 + stripTop && y < 97 + stripTop + height;
      if (!masked) count++;
    }
    return count;
  };
  assert.equal(hits(190, baseTop), 7, 'reproduces Main close 7/9');
  assert.equal(hits(256, baseTop), 6, 'reproduces Main maximize 6/9');
  assert.equal(height, 10, 'resize affordance thickness is retained');
  assert.equal(hits(190, top), 9);
  assert.equal(hits(256, top), 9);
  assert.ok(top + height <= 0, 'north resize stays outside the attached header');
});

// Test the cooked strings sent to evaluateChrome, not merely the outer .mjs.
// The first live failure was a regex whose slash escapes vanished while its
// enclosing template literal was evaluated.
test('every emitted privileged function parses before Firefox is contacted', () => {
  const source = readFileSync(new URL('./verify-semantic-zoom.mjs', import.meta.url), 'utf8');
  const calls = [...source.matchAll(/harness\.evaluateChrome\(/g)];
  assert.ok(calls.length >= 15, 'expected to cover the complete live QA flow');
  for (const call of calls) {
    const line = source.slice(0, call.index).split('\n').length;
    let start = call.index + call[0].length;
    while (/\s/.test(source[start])) start += 1;
    let emitted;
    if (source.startsWith('OBSERVE', start)) {
      emitted = OBSERVE;
    } else {
      assert.equal(source[start], '`', `uncovered evaluateChrome argument at line ${line}`);
      let end = start + 1;
      while (end < source.length) {
        if (source[end] === '`' && source[end - 1] !== '\\') break;
        end += 1;
      }
      assert.ok(end < source.length, `unterminated Chrome template at line ${line}`);
      const literal = source.slice(start, end + 1);
      emitted = Function('ids', 'chat', 'dataBrowserId', 'zoom', `return ${literal}`)(
        ['qa-browser-a', 'qa-browser-b', 'qa-browser-far'], 'qa-chat', 'qa-browser-b', 0.3,
      );
    }
    assert.match(emitted, /^\s*(?:async\s*)?\(\s*\)\s*=>/s, `not a callable Chrome function at line ${line}`);
    assert.doesNotThrow(() => Function(`return (${emitted})`), `invalid emitted Chrome function at line ${line}`);
    assert.ok(Buffer.byteLength(emitted, 'utf8') < 15 * 1024, `Chrome function too large at line ${line}`);
  }
});
