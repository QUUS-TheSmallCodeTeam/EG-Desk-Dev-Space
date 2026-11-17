import test from 'node:test';
import assert from 'node:assert/strict';
import * as AnnotationState from '../overlay/resources/EGDeskAnnotationState.sys.mjs';
import { createAnnotationZone } from '../overlay/resources/surface/EGDeskSurfaceAnnotation.mjs';
import { PRIVATE_KEYS } from '../helper/egdesk-chat-store.mjs';
import { normalizeAnnotationArguments } from '../helper/egdesk-annotation-tool-provider.mjs';

// A small DOM: enough tree, class, dataset, style, attribute and event
// behaviour for the annotation zone. Selectors: '.class', '#id' and
// '[data-testid="x"]', each alone.
class FakeNode {
  constructor(doc, tagName, ns = null) {
    Object.assign(this, { ownerDocument: doc, tagName: tagName.toUpperCase(), namespaceURI: ns, children: [], parentNode: null,
      attributes: new Map(), dataset: {}, style: {}, listeners: new Map(), text: '' });
    const node = this;
    this.classList = {
      add: (...names) => { const set = new Set(node.className.split(/\s+/).filter(Boolean)); names.forEach(n => set.add(n)); node.className = [...set].join(' '); },
      remove: (...names) => { node.className = node.className.split(/\s+/).filter(n => n && !names.includes(n)).join(' '); },
      contains: name => node.className.split(/\s+/).includes(name),
    };
    this.className = '';
  }
  get id() { return this.attributes.get('id') || ''; }
  set id(value) { this.attributes.set('id', String(value)); }
  setAttribute(name, value) { if (name === 'class') this.className = String(value); else this.attributes.set(name, String(value)); }
  getAttribute(name) { return name === 'class' ? this.className : this.attributes.get(name) ?? null; }
  addEventListener(type, fn) { (this.listeners.get(type) || this.listeners.set(type, []).get(type)).push(fn); }
  dispatch(type, extra = {}) {
    const ev = { type, currentTarget: this, target: this, preventDefault() {}, stopPropagation() {}, ...extra };
    for (const fn of this.listeners.get(type) || []) fn(ev);
  }
  click() { if (this.attributes.has('disabled')) return; this.dispatch('click'); }
  appendChild(child) {
    if (child.isFragmentText) { this.text += child.value; return child; }
    child.parentNode?.removeChild(child);
    child.parentNode = this; this.children.push(child); return child;
  }
  append(...nodes) { nodes.forEach(n => this.appendChild(n)); }
  prepend(...nodes) { for (const n of nodes.reverse()) { n.parentNode?.removeChild(n); n.parentNode = this; this.children.unshift(n); } }
  removeChild(child) { this.children = this.children.filter(c => c !== child); child.parentNode = null; }
  remove() { this.parentNode?.removeChild(this); }
  replaceWith(node) {
    const parent = this.parentNode, index = parent.children.indexOf(this);
    node.parentNode?.removeChild(node);
    parent.children[index] = node; node.parentNode = parent; this.parentNode = null;
  }
  get isConnected() { let n = this; while (n.parentNode) n = n.parentNode; return n === this.ownerDocument.documentElement; }
  get textContent() { return this.text + this.children.map(c => c.textContent).join(''); }
  set textContent(value) { this.children = []; this.text = String(value); }
  get offsetWidth() { return parseFloat(this.style.width) || 0; }
  get offsetHeight() { return parseFloat(this.style.height) || 0; }
  matches(selector) {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    const data = /^\[data-([a-z-]+)="([^"]*)"\]$/.exec(selector);
    if (data) return this.dataset[data[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] === data[2];
    return this.tagName === selector.toUpperCase();
  }
  *walk() { for (const c of this.children) { yield c; yield* c.walk(); } }
  querySelectorAll(selector) { return [...this.walk()].filter(n => n.matches(selector)); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  closest(selector) { let n = this; while (n && n.matches) { if (n.matches(selector)) return n; n = n.parentNode; } return null; }
}

function fakeDocument() {
  const doc = { createElement: tag => new FakeNode(doc, tag), createElementNS: (ns, tag) => new FakeNode(doc, tag, ns),
    createTextNode: value => ({ isFragmentText: true, value }) };
  doc.documentElement = new FakeNode(doc, 'html');
  doc.getElementById = id => doc.documentElement.querySelector(`#${id}`);
  doc.querySelectorAll = selector => doc.documentElement.querySelectorAll(selector);
  doc.querySelector = selector => doc.documentElement.querySelector(selector);
  return doc;
}

function makeEl(doc, svg) {
  return (tag, props = {}, ...children) => {
    const node = svg ? doc.createElementNS('http://www.w3.org/2000/svg', tag) : doc.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style') Object.assign(node.style, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'data') Object.assign(node.dataset, v);
      else node.setAttribute(k, v);
    }
    for (const c of children) if (c != null) node.appendChild(typeof c === 'string' ? doc.createTextNode(c) : c);
    return node;
  };
}

function setup() {
  const doc = fakeDocument();
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  const el = makeEl(doc, false), svgEl = makeEl(doc, true);
  const calls = { dirty: [], save: 0, focus: [], reveal: [] };
  const zone = createAnnotationZone(Object.freeze({
    AnnotationState, el, svgEl,
    focusCanvasCard: card => calls.focus.push(card.id),
    revealOpenCanvasCard: (card, options) => calls.reveal.push({ id: card.id, kind: options.kind }),
    markAgendaDirty: (reason, card) => calls.dirty.push({ reason, id: card?.id }),
    scheduleDeskSessionSave: () => { calls.save += 1; },
  }));
  const layer = el('div', { id: 'egd-canvas-layer' });
  doc.documentElement.appendChild(layer);
  let uri = 'https://example.com/login';
  const browserCard = (id = 'egd-card-7') => {
    const wrap = el('div', { class: 'egd-card-wrap', style: { width: '1000px', height: '800px', transform: 'scale(0.5)' } });
    const body = el('div', { class: 'egd-card-body egd-desk-window-body' }, wrap);
    const card = el('div', { id, class: 'egd-canvas-card egd-desk-window' }, body);
    card._browserControls = { getState: () => ({ cardId: id, uri }) };
    layer.appendChild(card);
    return card;
  };
  const restore = () => { if (prior) Object.defineProperty(globalThis, 'document', prior); else delete globalThis.document; };
  return { doc, el, zone, calls, layer, browserCard, navigate: next => { uri = next; }, restore };
}

const published = (over = {}) => ({ annotation: normalizeAnnotationArguments({
  cardId: 'egd-card-7', targetKind: 'browser', summary: '로그인 버튼 위치', units: 'viewportPx', grounding: 'dom',
  observation: { documentId: 'doc-1', revision: 4, viewport: { width: 1000, height: 800 }, scroll: { x: 0, y: 0 } },
  items: [
    { id: 'login', type: 'box', rect: { x: 100, y: 160, w: 300, h: 80 }, label: '로그인 버튼', ref: 'e12' },
    { id: 'hint', type: 'label', at: { x: 500, y: 40 }, label: '여기' },
    { id: 'point', type: 'arrow', from: { x: 500, y: 60 }, to: { x: 250, y: 160 }, toItemId: 'login' },
  ],
  ...over,
}, { run: { runId: 'turn-1', answerId: 'answer-7' }, now: 1000, newId: () => 'ann-1' }) });
const run = { answerId: 'answer-7', runId: 'turn-1' };
const bar = (h, id = 'ann-1') => h.doc.querySelectorAll('[data-testid="annotation-bar"]').find(node => node.dataset.annotationSetId === id);
const button = (h, testid, id = 'ann-1') => bar(h, id)?.querySelector(`[data-testid="${testid}"]`);

test('D-K1: a published set appears over its Browser card as a dotted proposal; the camera does not move', t => {
  const h = setup(); t.after(h.restore);
  const card = h.browserCard();
  assert.equal(h.zone.receivePublishedAnnotation(run, published()), 'ann-1');
  const layer = h.doc.getElementById('egd-annotation-ann-1');
  assert.ok(layer, 'stable layer id');
  assert.equal(layer.parentNode, card.querySelector('.egd-card-wrap'), 'marks sit in the page wrap, so they follow move and resize');
  assert.deepEqual([layer.dataset.annotationSetId, layer.dataset.status, layer.dataset.freshness], ['ann-1', 'proposed', 'current']);
  const rect = layer.querySelector('.egd-annotation-mark-box');
  assert.deepEqual(['x', 'y', 'width', 'height'].map(k => rect.getAttribute(k)), ['100', '160', '300', '80'], 'ratios projected onto the 1000×800 page');
  assert.ok(rect.getAttribute('stroke-dasharray'), 'a proposal is dotted');
  assert.equal(rect.getAttribute('stroke-width'), '4', 'stroke compensates the 0.5 page scale');
  const arrow = layer.querySelector('.egd-annotation-mark-arrow');
  assert.match(arrow.getAttribute('marker-end'), /^url\(#egd-annotation-ann-1-arrow\)$/);
  assert.deepEqual(layer.querySelectorAll('.egd-annotation-label').map(n => n.textContent), ['로그인 버튼', '여기']);
  const controls = bar(h);
  assert.equal(controls.parentNode.parentNode, card.querySelector('.egd-card-body'), 'controls stay unscaled in the window body');
  assert.equal(controls.querySelector('.egd-annotation-badge').textContent, 'AI 제안');
  assert.equal(controls.querySelector('.egd-annotation-summary').textContent, '로그인 버튼 위치');
  assert.deepEqual([h.calls.focus, h.calls.reveal, h.calls.dirty, h.calls.save], [[], [], [], 0], 'no camera move, nothing saved');
  assert.deepEqual(h.zone.annotationRecordsForCard(card), [], 'a proposal is not part of the saved card');
});

test('Agent input can only propose; a repeated or malformed delivery changes nothing', t => {
  const h = setup(); t.after(h.restore);
  h.browserCard();
  const sneaky = published();
  sneaky.annotation.items[0].status = 'accepted';
  h.zone.receivePublishedAnnotation(run, sneaky);
  assert.equal(h.zone.getAnnotationSet('ann-1').items[0].status, 'proposed');
  assert.equal(h.zone.receivePublishedAnnotation(run, published()), 'ann-1');
  assert.equal(h.doc.querySelectorAll('[data-testid="annotation-layer"]').length, 1);
  assert.equal(h.zone.receivePublishedAnnotation(run, { annotation: { id: 'x', items: [] } }), null);
  assert.equal(h.zone.receivePublishedAnnotation(run, {}), null);
  assert.equal(h.zone.listAnnotationSets().length, 1);
});

test('[모두 받기] keeps the whole set: solid marks, Board dirty once, card record carries only kept marks', t => {
  const h = setup(); t.after(h.restore);
  const card = h.browserCard();
  h.zone.receivePublishedAnnotation(run, published());
  button(h, 'annotation-accept').click();
  const layer = h.doc.getElementById('egd-annotation-ann-1');
  assert.equal(layer.dataset.status, 'accepted');
  assert.equal(layer.querySelector('.egd-annotation-mark-box').getAttribute('stroke-dasharray'), null, 'kept marks are solid');
  assert.equal(bar(h).querySelector('.egd-annotation-badge').textContent, '표식');
  assert.deepEqual(h.calls.dirty, [{ reason: 'annotation-change', id: 'egd-card-7' }]);
  const records = h.zone.annotationRecordsForCard(card);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0].items.map(i => [i.id, i.status]), [['login', 'accepted'], ['hint', 'accepted'], ['point', 'accepted']]);
  const found = [];
  JSON.stringify(records, (key, value) => { if (PRIVATE_KEYS.has(key.toLowerCase().replace(/[_-]/g, ''))) found.push(key); return value; });
  assert.deepEqual(found, []);
  button(h, 'annotation-dismiss').click();
  assert.equal(h.doc.getElementById('egd-annotation-ann-1'), null, 'a removed set leaves the card');
  assert.equal(h.calls.dirty.length, 2, 'removing kept marks is a Board change');
  assert.deepEqual(h.zone.annotationRecordsForCard(card), []);
});

test('[하나씩] accepts or dismisses single marks; dismissing a proposal is not a Board change', t => {
  const h = setup(); t.after(h.restore);
  const card = h.browserCard();
  h.zone.receivePublishedAnnotation(run, published());
  button(h, 'annotation-each').click();
  const rows = () => bar(h).querySelector('[data-testid="annotation-items"]').children;
  assert.deepEqual(rows().map(r => r.dataset.annotationItemId), ['login', 'hint', 'point']);
  rows()[1].querySelector('[data-testid="annotation-item-dismiss"]').click();
  assert.equal(h.calls.dirty.length, 0);
  rows()[0].querySelector('[data-testid="annotation-item-accept"]').click();
  assert.equal(h.zone.getAnnotationSet('ann-1').status, 'partial');
  assert.equal(bar(h).querySelector('.egd-annotation-badge').textContent, 'AI 제안 · 일부 받음');
  assert.equal(h.calls.dirty.length, 1);
  const saved = h.zone.annotationRecordsForCard(card)[0];
  assert.deepEqual(saved.items.map(i => i.id), ['login'], 'the arrow that pointed at it is still a proposal and is not saved');
  button(h, 'annotation-dismiss').click();   // 남은 것 지우기: proposals only
  assert.equal(h.zone.getAnnotationSet('ann-1').status, 'accepted');
  assert.deepEqual(h.zone.annotationRecordsForCard(card)[0].items.map(i => i.id), ['login']);
  assert.equal(h.calls.dirty.length, 1);
});

test('another page in the card makes the proposal stale: accept is refused with a reason, dismiss still works', t => {
  const h = setup(); t.after(h.restore);
  h.browserCard();
  h.zone.receivePublishedAnnotation(run, published());
  h.navigate('https://example.com/home');
  h.zone.refreshAnnotations();
  assert.equal(h.doc.getElementById('egd-annotation-ann-1').dataset.freshness, 'stale');
  assert.equal(button(h, 'annotation-accept').getAttribute('disabled'), 'true');
  assert.equal(h.zone.acceptAnnotationSet('ann-1'), false);
  assert.match(bar(h).querySelector('[data-testid="annotation-notice"]').textContent, /받지 않았습니다: .*페이지가 바뀌었습니다/);
  assert.equal(h.zone.getAnnotationSet('ann-1').status, 'proposed');
  button(h, 'annotation-dismiss').click();
  assert.equal(h.zone.getAnnotationSet('ann-1').status, 'dismissed');
  assert.equal(h.calls.dirty.length, 0);
});

test('a missing target keeps the set for its chip only; restore puts kept marks on the new card id with the same set id', t => {
  const h = setup(); t.after(h.restore);
  h.zone.receivePublishedAnnotation(run, published());
  assert.equal(h.doc.querySelectorAll('[data-testid="annotation-layer"]').length, 0);
  const chip = h.zone.annotationChipsForAnswer({ role: 'assistant', answerId: 'answer-7' }, {})[0];
  assert.equal(chip.querySelector('.egd-codex-result-version').textContent, '대상 창 없음');
  assert.equal(h.zone.annotationTarget('ann-1'), null);
  // The saved record, as Board/Desk save keeps it.
  const card = h.browserCard();
  h.zone.acceptAnnotationSet('ann-1');
  const records = h.zone.annotationRecordsForCard(card);
  card.remove();
  const reopened = h.browserCard('egd-restored-12');
  const ids = h.zone.restoreCardAnnotations(reopened, records);
  assert.deepEqual(ids, ['ann-1']);
  const restored = h.zone.getAnnotationSet('ann-1');
  assert.deepEqual([restored.targetCardId, restored.cardId, restored.status], ['egd-restored-12', 'egd-restored-12', 'accepted']);
  assert.equal(restored.freshness, 'unknown', 'a restored Browser set cannot prove its page; it is shown dimmed');
  assert.equal(h.doc.getElementById('egd-annotation-ann-1').parentNode, reopened.querySelector('.egd-card-wrap'));
  assert.equal(h.zone.annotationChipsForAnswer({ role: 'assistant', answerId: 'answer-7' }, {}).length, 1, 'the chip finds a restored set by its answer');
  // Two live copies of one saved card: the second gets its own id.
  const copy = h.browserCard('egd-restored-13');
  assert.deepEqual(h.zone.restoreCardAnnotations(copy, records), ['ann-1.r2']);
  assert.deepEqual(h.zone.restoreCardAnnotations(copy, [{ id: 'bad' }, null]), []);
});

test('chat chip: one per set under its answer, opens the target with emphasis, follows the set status, none for Claude', t => {
  const h = setup(); t.after(h.restore);
  h.browserCard();
  h.zone.receivePublishedAnnotation(run, published());
  const message = { role: 'assistant', answerId: 'answer-7' };
  assert.deepEqual(h.zone.annotationChipsForAnswer({ role: 'user', answerId: 'answer-7' }, {}), []);
  assert.deepEqual(h.zone.annotationChipsForAnswer({ role: 'assistant', answerId: 'other' }, {}), []);
  assert.deepEqual(h.zone.annotationChipsForAnswer(message, { engineId: 'claude' }), []);
  const [chip] = h.zone.annotationChipsForAnswer(message, {});
  assert.equal(chip.dataset.testid, 'chat-annotation');
  assert.equal(chip.dataset.annotationSetId, 'ann-1');
  assert.equal(chip.querySelector('.egd-codex-result-kind').textContent, '표식');
  assert.equal(chip.querySelector('.egd-codex-result-label').textContent, '로그인 버튼 위치');
  assert.equal(chip.querySelector('.egd-codex-result-version').textContent, '표식 3개 · 확인 대기 3');
  h.doc.documentElement.appendChild(chip);
  chip.click();
  assert.deepEqual(h.calls.focus, ['egd-card-7']);
  assert.deepEqual(h.calls.reveal, [{ id: 'egd-card-7', kind: 'annotation' }]);
  assert.equal(h.doc.getElementById('egd-annotation-ann-1').dataset.emphasis, 'true');
  h.zone.acceptAnnotationSet('ann-1');
  assert.equal(chip.querySelector('.egd-codex-result-version').textContent, '표식 3개 · 받음 3');
});

test('free Canvas set: drawn in Canvas world pixels, saved with the Desk session only once accepted', t => {
  const h = setup(); t.after(h.restore);
  const set = normalizeAnnotationArguments({ summary: '정리할 곳', items: [{ type: 'ellipse', rect: { x: 1200, y: -40, w: 300, h: 200 } }] },
    { now: 1, newId: () => 'ann-canvas' });
  h.zone.receivePublishedAnnotation(run, { annotation: set });
  const layer = h.doc.getElementById('egd-annotation-ann-canvas');
  assert.equal(layer.parentNode, h.layer);
  const ellipse = layer.querySelector('.egd-annotation-mark-ellipse');
  assert.deepEqual(['cx', 'cy', 'rx', 'ry'].map(k => ellipse.getAttribute(k)), ['1350', '60', '150', '100']);
  const controls = bar(h, 'ann-canvas');
  assert.equal(controls.parentNode, h.layer);
  assert.deepEqual([controls.style.left, controls.style.top], ['1200px', '-40px']);
  assert.deepEqual(h.zone.annotationCanvasRecords(), []);
  button(h, 'annotation-accept', 'ann-canvas').click();
  assert.equal(h.calls.save, 1, 'no card: the Desk session saves it');
  const records = h.zone.annotationCanvasRecords();
  assert.equal(records.length, 1);
  h.zone.dismissAnnotationSet('ann-canvas');
  assert.deepEqual(h.zone.restoreCanvasAnnotations(records), ['ann-canvas']);
  assert.equal(h.zone.getAnnotationSet('ann-canvas').status, 'accepted');
  assert.deepEqual(h.zone.restoreCanvasAnnotations(published().annotation ? [published().annotation] : []), [], 'a card set is not a Canvas set');
});

test('Briefing API: a stable id resolves to its card and layer; reads are copies and never change the set', t => {
  const h = setup(); t.after(h.restore);
  const card = h.browserCard();
  h.zone.receivePublishedAnnotation(run, published());
  const view = h.zone.getAnnotationSet('ann-1');
  view.items[0].status = 'accepted';
  view.items.length = 0;
  assert.equal(h.zone.getAnnotationSet('ann-1').items.length, 3);
  assert.equal(h.zone.getAnnotationSet('nope'), null);
  assert.deepEqual(h.zone.listAnnotationSets({ cardId: 'egd-card-7' }), [
    { id: 'ann-1', status: 'proposed', summary: '로그인 버튼 위치', cardId: 'egd-card-7', space: 'card', itemCount: 3, freshness: 'current' }]);
  assert.deepEqual(h.zone.listAnnotationSets({ cardId: 'other' }), []);
  const target = h.zone.annotationTarget('ann-1');
  assert.deepEqual([target.setId, target.space, target.cardId, target.card, target.layer.id, target.itemIds],
    ['ann-1', 'card', 'egd-card-7', card, 'egd-annotation-ann-1', ['login', 'hint', 'point']]);
  assert.equal(h.zone.emphasizeAnnotationSet('ann-1', true), true);
  assert.equal(target.layer.dataset.emphasis, 'true');
  h.zone.emphasizeAnnotationSet('ann-1', false);
  assert.equal(target.layer.dataset.emphasis, undefined);
  assert.equal(h.calls.dirty.length + h.calls.save, 0);
  h.zone.dismissAnnotationSet('ann-1');
  assert.equal(h.zone.annotationTarget('ann-1'), null);
  assert.deepEqual(h.zone.listAnnotationSets(), []);
  assert.equal(h.zone.listAnnotationSets({ includeDismissed: true }).length, 1);
  assert.equal(h.zone.revealAnnotationSet('ann-1'), false);
});
