import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RESOURCE_NUMBER_CH, amountText, amountValue, createWriteGate, pairStatusValue, pairValue, percentParts, percentValue, rangeValue,
  sizeParts, syncValue, textValue,
} from '../overlay/resources/EGDeskResourceReadout.sys.mjs';

const surfaceSource = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const surfaceCss = readFileSync(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url), 'utf8');

// Counts every write a renderer makes, so "nothing changed" is observable.
function fakeNode(tag = 'span') {
  let text = '';
  const node = {
    tag, className: '', children: [], attributes: new Map(), writes: 0,
    style: {
      values: new Map(),
      setProperty(name, value) { node.writes += 1; this.values.set(name, value); },
    },
    classList: { toggle(name, on) { node.writes += 1; node.attributes.set(`class:${name}`, on); } },
    get textContent() { return text; },
    set textContent(value) { node.writes += 1; text = String(value); },
    get title() { return node.attributes.get('title'); },
    set title(value) { node.writes += 1; node.attributes.set('title', value); },
    setAttribute(name, value) { node.writes += 1; node.attributes.set(name, value); },
    getAttribute(name) { return node.attributes.get(name) ?? null; },
    appendChild(child) { node.writes += 1; node.children.push(child); return child; },
    replaceChildren(...next) { node.writes += 1; node.rebuilt = (node.rebuilt || 0) + 1; node.children = next; },
    querySelector(selector) {
      const wanted = selector.replace(/^\./, '');
      const walk = (item) => item.className.split(' ').includes(wanted) ? item
        : item.children.map(walk).find(Boolean) || null;
      return node.children.map(walk).find(Boolean) || null;
    },
    addEventListener() {}, removeEventListener() {}, focus() {}, contains() { return false; },
  };
  return node;
}
const makeCell = (cell) => { const node = fakeNode(); node.className = `egd-resource-cell-${cell.kind}`; node.textContent = cell.text; return node; };
const totalWrites = (node) => node.writes + node.children.reduce((sum, child) => sum + totalWrites(child), 0);

test('a size keeps three significant digits so the number never grows past four characters', () => {
  assert.deepEqual(sizeParts(0), { number: '0', unit: 'B' });
  assert.deepEqual(sizeParts(999), { number: '999', unit: 'B' });
  // 1000 B would be a fourth digit: it moves to the next unit instead.
  assert.deepEqual(sizeParts(1000), { number: '0.98', unit: 'KiB' });
  assert.deepEqual(sizeParts(1024), { number: '1.00', unit: 'KiB' });
  assert.deepEqual(sizeParts(10 * 1024), { number: '10.0', unit: 'KiB' });
  assert.deepEqual(sizeParts(512 * 1024), { number: '512', unit: 'KiB' });
  assert.deepEqual(sizeParts(1023 * 1024), { number: '1.00', unit: 'MiB' });
  assert.deepEqual(sizeParts(12.34 * 1024 ** 2), { number: '12.3', unit: 'MiB' });
  assert.deepEqual(sizeParts(16 * 1024 ** 3), { number: '16.0', unit: 'GiB' });
  assert.equal(sizeParts(-1), null);
  assert.equal(sizeParts(Number.NaN), null);
  assert.equal(sizeParts('12'), null);

  for (let exponent = 0; exponent < 44; exponent += 0.07) {
    const parts = sizeParts(2 ** exponent);
    assert.ok(parts.number.length <= RESOURCE_NUMBER_CH, `${2 ** exponent} -> ${parts.number}`);
    assert.match(parts.number, /^\d+(\.\d+)?$/);
  }
});

test('a percent is a whole number between 0 and 100', () => {
  assert.deepEqual(percentParts(9.4), { number: '9', unit: '%' });
  assert.deepEqual(percentParts(99.6), { number: '100', unit: '%' });
  assert.deepEqual(percentParts(180), { number: '100', unit: '%' });
  assert.equal(percentParts(undefined), null);
  assert.equal(percentParts(-3), null);
  assert.deepEqual(percentValue(percentParts(42)), { layout: 'percent', cells: [{ kind: 'num', text: '42' }, { kind: 'unit', text: '%' }] });
  assert.deepEqual(percentValue(null).cells.map(cell => cell.text), ['—', '']);
});

test('a missing measurement keeps the same cells as a measured one', () => {
  const measured = amountValue(sizeParts(2048), '/s');
  const missing = amountValue(null, '/s');
  assert.deepEqual(measured.cells.map(cell => cell.kind), ['num', 'unit']);
  assert.deepEqual(missing.cells.map(cell => cell.kind), ['num', 'unit']);
  assert.equal(measured.layout, missing.layout);
  assert.deepEqual(measured.cells.map(cell => cell.text), ['2.00', 'KiB/s']);
  assert.deepEqual(missing.cells.map(cell => cell.text), ['—', '']);
  assert.equal(amountText(sizeParts(2048), '/s'), '2.00 KiB/s');
  assert.equal(amountText(null, '/s'), '—');

  const pair = pairValue('읽기', sizeParts(5 * 1024 ** 2), '쓰기', null, '/s');
  assert.equal(pair.layout, 'pair');
  assert.deepEqual(pair.cells.map(cell => cell.kind), ['label', 'num', 'unit', 'label', 'num', 'unit']);
  assert.deepEqual(pair.cells.map(cell => cell.text), ['읽기', '5.00', 'MiB/s', '쓰기', '—', '']);
  assert.deepEqual(rangeValue(sizeParts(1024 ** 3), sizeParts(8 * 1024 ** 3)).cells.map(cell => cell.text),
    ['1.00', 'GiB', '/', '8.00', 'GiB']);
  assert.deepEqual(textValue('측정 준비 중'), { layout: 'text', cells: [{ kind: 'text', text: '측정 준비 중' }] });
  assert.deepEqual(pairStatusValue('측정 준비 중'), { layout: 'pair-status', cells: [{ kind: 'text', text: '측정 준비 중' }] });
});

test('syncValue keeps the same cells and writes only the text that changed', () => {
  const host = fakeNode('dd');
  syncValue(host, pairValue('수신', sizeParts(900), '송신', sizeParts(10), '/s'), makeCell);
  assert.equal(host.rebuilt, 1);
  assert.equal(host.className, 'egd-resource-figure egd-resource-figure-pair');
  const cells = [...host.children];
  const before = totalWrites(host);

  // Same numbers again: nothing is touched.
  assert.equal(syncValue(host, pairValue('수신', sizeParts(900), '송신', sizeParts(10), '/s'), makeCell), 0);
  assert.equal(totalWrites(host), before);

  // 900 B/s -> 12.3 MiB/s crosses two units: the same nodes get new text.
  assert.equal(syncValue(host, pairValue('수신', sizeParts(12.3 * 1024 ** 2), '송신', sizeParts(10), '/s'), makeCell), 2);
  assert.equal(host.rebuilt, 1);
  assert.deepEqual([...host.children], cells);
  assert.deepEqual(host.children.map(child => child.textContent), ['수신', '12.3', 'MiB/s', '송신', '10', 'B/s']);
  assert.equal(totalWrites(host), before + 2);

  // Measured -> not measured keeps the cells too.
  assert.equal(syncValue(host, pairValue('수신', null, '송신', null, '/s'), makeCell), 4);
  assert.equal(host.rebuilt, 1);

  // Only a different shape (words instead of numbers) rebuilds.
  syncValue(host, textValue('측정할 수 없음'), makeCell);
  assert.equal(host.rebuilt, 2);
  assert.equal(host.className, 'egd-resource-figure egd-resource-figure-text');
});

test('the write gate skips a value it already wrote', () => {
  const written = [];
  const put = createWriteGate();
  assert.equal(put('cpu:title', 'CPU · 12%', (value) => written.push(value)), true);
  assert.equal(put('cpu:title', 'CPU · 12%', (value) => written.push(value)), false);
  assert.equal(put('cpu:title', 'CPU · 13%', (value) => written.push(value)), true);
  assert.equal(put('memory:title', 'CPU · 13%', (value) => written.push(value)), true);
  assert.deepEqual(written, ['CPU · 12%', 'CPU · 13%', 'CPU · 13%']);
});

// ---- the gadget as the Desk draws it ----
function gadgetHarness() {
  const start = surfaceSource.indexOf('  const ResourceReadout = ChromeUtils.importESModule(');
  const end = surfaceSource.indexOf('  // ============ Top: Viewport Agenda Rail ============', start);
  assert.ok(start > 0 && end > start, 'resource gadget block is present');
  const block = surfaceSource.slice(start, end);
  const responses = [];
  const timers = [];
  const made = [];
  const el = (tag, props = {}, ...children) => {
    const node = fakeNode(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key.startsWith('on')) node[key] = value;
      else node.attributes.set(key, value);
    }
    for (const child of children) {
      if (child == null) continue;
      if (typeof child === 'string') node.textContent = child; else node.children.push(child);
    }
    node.writes = 0;
    made.push(node);
    return node;
  };
  const document = { hidden: false, addEventListener() {}, removeEventListener() {} };
  const window = {
    setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
    addEventListener() {}, removeEventListener() {},
  };
  const fetch = async () => ({ ok: true, json: async () => responses.shift() });
  const ChromeUtils = { importESModule: () => readoutModule };
  const build = new Function('el', 'document', 'window', 'fetch', 'performance', 'ChromeUtils', 'AbortController',
    `${block}\nreturn buildResourceGadget;`)(el, document, window, fetch, { now: () => 0 }, ChromeUtils, AbortController);
  return { build, responses, timers, made };
}
import * as readoutModule from '../overlay/resources/EGDeskResourceReadout.sys.mjs';

const snapshotAt = (overrides = {}) => ({
  version: 1, scope: 'host', sampledAt: new Date().toISOString(),
  cpu: { status: 'ok', percent: 9.2, basis: 'all-logical-cores', intervalMs: 1000 },
  memory: { status: 'ok', percent: 61.4, usedBytes: 9.8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3, basis: 'total-minus-os-free' },
  disk: { status: 'ok', percent: 40, usedBytes: 200 * 1024 ** 3, totalBytes: 500 * 1024 ** 3, sampledAt: '2026-11-14T04:20:00.000Z', target: 'profile-volume' },
  diskIo: { status: 'ok', readBytesPerSecond: 900, writeBytesPerSecond: 0, intervalMs: 1000 },
  network: { status: 'ok', rxBytesPerSecond: 900, txBytesPerSecond: 120, interface: 'en0', intervalMs: 1000 },
  ...overrides,
});
const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };

test('a new sample changes text in place: no row or ring is rebuilt, an equal sample writes nothing', async () => {
  const { build, responses, timers, made } = gadgetHarness();
  const first = snapshotAt();
  responses.push(first);
  const gadget = build();
  await settle();
  const buttons = gadget.children.filter(child => child.tag === 'button');
  const detail = gadget.children.find(child => child.tag === 'section');
  assert.equal(buttons.length, 4);
  buttons[0].onclick({ stopPropagation() {} });

  const dds = () => made.filter(node => node.tag === 'dd' && detail.children.some(function holds(item) {
    return item === node || item.children.some(holds);
  }));
  const shownDds = dds();
  const skeleton = [...detail.children];
  const cellsBefore = shownDds.map(dd => [...dd.children]);
  const cpuRing = buttons[0].querySelector('egd-resource-ring') || buttons[0].children[0];
  assert.equal(cpuRing.style.values.get('--egd-resource-fill'), '9%');
  assert.equal(buttons[0].attributes.get('title'), 'CPU · 9%');

  // The same measurements arrive again a second later with a new timestamp of the same second.
  const everything = () => [gadget, ...made].reduce((sum, node) => sum + node.writes, 0);
  let before = everything();
  responses.push({ ...first });
  await timers.pop()();
  await settle();
  assert.equal(everything(), before, 'an unchanged sample touches nothing');

  // 9% -> 10%, 900 B/s -> 12.3 MiB/s: digits and units change, nodes stay.
  responses.push(snapshotAt({
    sampledAt: first.sampledAt,
    cpu: { ...first.cpu, percent: 10.4, intervalMs: 998 },
    network: { ...first.network, rxBytesPerSecond: 12.3 * 1024 ** 2 },
  }));
  before = everything();
  await timers.pop()();
  await settle();
  assert.deepEqual([...detail.children], skeleton, 'the popup keeps its parts');
  assert.deepEqual(dds(), shownDds, 'the popup keeps its rows');
  assert.deepEqual(shownDds.map(dd => [...dd.children]), cellsBefore, 'every value keeps its cells');
  assert.equal(detail.rebuilt || 0, 0);
  assert.equal(cpuRing.style.values.get('--egd-resource-fill'), '10%');
  assert.equal(buttons[0].attributes.get('title'), 'CPU · 10%');
  assert.equal(buttons[3].attributes.get('title'), '네트워크 · 수신 12.3 MiB/s, 송신 120 B/s');
  // 1000 ms -> 998 ms: the measuring interval is a number cell and a unit cell as well.
  assert.equal(shownDds.at(-1).className, 'egd-resource-figure egd-resource-figure-size');
  assert.deepEqual(shownDds.at(-1).children.map(cell => cell.textContent), ['998', 'ms']);
  // cpu: title, aria-label, ring fill, overview number, detail number, detail interval;
  // network: title, aria-label, overview number + unit.
  assert.equal(everything() - before, 10);
});

test('the bar and the popup are drawn without rebuilding the popup on every sample', () => {
  const start = surfaceSource.indexOf('  const ResourceReadout = ChromeUtils.importESModule(');
  const block = surfaceSource.slice(start, surfaceSource.indexOf('  // ============ Top: Viewport Agenda Rail ============', start));
  const renderDetail = block.slice(block.indexOf('const renderDetail = '), block.indexOf('const render = '));
  assert.doesNotMatch(renderDetail, /detail\.replaceChildren/);
  assert.doesNotMatch(block, /innerHTML/);
  assert.match(block, /ResourceReadout\.syncValue\(/);
});

test('number and unit cells have a fixed width and tabular digits', () => {
  const rule = (selector) => {
    const at = surfaceCss.indexOf(`\n${selector} {`);
    assert.ok(at >= 0, `${selector} rule exists`);
    return surfaceCss.slice(at, surfaceCss.indexOf('}', at));
  };
  assert.match(rule('.egd-resource-cell-num'), new RegExp(`width: ${RESOURCE_NUMBER_CH}ch;`));
  assert.match(rule('.egd-resource-cell-num'), /text-align: right;/);
  assert.match(rule('.egd-resource-cell-unit'), /width: [\d.]+ch;/);
  assert.match(rule('.egd-resource-cell-unit'), /text-align: left;/);
  assert.match(rule('.egd-resource-figure-pair'), /grid-template-columns: auto \d+ch [\d.]+ch;/);
  // Status words in place of two speeds reserve the same two lines.
  assert.match(rule('.egd-resource-figure-pair-status'), /min-height: calc\(2\.9em \+ 2px\);/);
  assert.match(rule('.egd-resource-detail-row dd'), /font-variant-numeric: tabular-nums;/);
  assert.match(rule('.egd-resource-detail-scope'), /font-variant-numeric: tabular-nums;/);
  assert.match(rule('.egd-resource-detail'), /\n  width: 246px;/);
  // Chat usage: 9% -> 10% -> 100% keeps the head columns still.
  assert.match(rule('.egd-usage-text'), /min-width: 4ch;/);
  assert.match(rule('.egd-usage-meter'), /font-variant-numeric: tabular-nums;/);
  assert.match(rule('.egd-zoom-value'), /min-width: 45px;[\s\S]*font-variant-numeric: tabular-nums;/);
});
