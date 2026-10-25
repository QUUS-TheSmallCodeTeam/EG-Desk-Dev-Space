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

function renderedLevel({ width = 1150.4, zoom = .8, previous = 'outline', metrics } = {}) {
  const start = overlay.indexOf('        const projectedFont =', overlay.indexOf('    const render = () => {', overlay.indexOf('function installSemanticZoom')));
  const end = overlay.indexOf('        if (level !== entry.level)', start);
  assert.ok(start > 0 && end > start);
  const helper = functionSource('browserPresentationFont') || 'function browserPresentationFont() { return null; }';
  return compileFunction(`${helper}\n${overlay.slice(start, end)}\nreturn level;`,
    ['entry', 'card', 'rect', 'zoom', 'SurfaceState', 'isCardFullscreen', 'detailWidth', 'detailHeight'])(
    { kind: 'browser', bodyFontPx: 11, level: previous },
    { _browserPresentation: { font: () => metrics ? metrics.fontPx * width / metrics.viewportWidth : null } },
    { width: 1440 * zoom, height: 640 * zoom }, zoom, SurfaceState, () => false, 240, 180);
}
const metric = Object.freeze({ version: 1, complete: true, fontPx: 16,
  viewportWidth: 1440, viewportHeight: 573, sampleCount: 8 });

test('actual Browser render restores readable wide content, not the 11px chrome wrapper', () => {
  assert.equal(renderedLevel({ metrics: metric }), 'detail');
  assert.equal(renderedLevel({ width: 1078.5, zoom: .75, metrics: metric }), 'detail');
  assert.equal(renderedLevel({ width: 766.4, previous: 'detail', metrics: metric }), 'outline');
  assert.equal(renderedLevel({ width: 431.4, zoom: .3, metrics: metric }), 'outline');
  assert.equal(renderedLevel(), 'outline', 'missing content evidence retains conservative fallback');
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

test('measured Browser detail retains common font hysteresis rather than raw zoom bands', () => {
  assert.equal(renderedLevel({ width: 9.2 / 16 * 1440, zoom: .6, previous: 'detail', metrics: metric }), 'detail');
  assert.equal(renderedLevel({ width: 9.2 / 16 * 1440, zoom: .6, previous: 'outline', metrics: metric }), 'outline');
  assert.equal(renderedLevel({ width: 10.6 / 16 * 1440, zoom: .6, previous: 'outline', metrics: metric }), 'detail');
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
