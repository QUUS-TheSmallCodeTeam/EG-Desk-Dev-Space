// CNV-07 Canvas-area briefing targets on the screen: production outline layer
// (syncBriefingRegions) and the off-screen step marks of the minimap.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFunction } from 'node:vm';
import { readSurfaceSource } from './egdesk-surface-source.mjs';
import * as BriefingState from '../overlay/resources/EGDeskBriefingState.sys.mjs';

const surfaceSource = readSurfaceSource();
const declaration = name => {
  const start = surfaceSource.indexOf(`  function ${name}(`);
  const end = start < 0 ? -1 : surfaceSource.indexOf('\n  }\n', start);
  return end < 0 ? null : surfaceSource.slice(start, end + 4);
};

function fakeNode(tag, props = {}, ...children) {
  const node = { tagName: tag.toUpperCase(), className: props.class || '', attributes: {}, dataset: { ...(props.data || {}) }, style: { ...(props.style || {}) },
    children: [], parentNode: null, textContent: '',
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; },
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(item => item !== this); this.parentNode = null; } };
  for (const [key, value] of Object.entries(props)) if (!['class', 'data', 'style'].includes(key)) node.attributes[key] = value;
  for (const child of children.filter(Boolean)) {
    if (typeof child === 'string') node.textContent += child;
    else { node.appendChild(child); node.textContent += child.textContent || ''; }
  }
  return node;
}

function regionHarness() {
  const layer = fakeNode('div');
  layer.querySelectorAll = selector => {
    assert.equal(selector, ':scope > .egd-briefing-region');
    return layer.children.filter(child => child.className === 'egd-briefing-region');
  };
  const document = { getElementById: id => id === 'egd-canvas-layer' ? layer : null };
  const source = declaration('syncBriefingRegions');
  assert.ok(source, 'production syncBriefingRegions exists');
  const sync = compileFunction(`${source}\nreturn syncBriefingRegions;`, ['document', 'el'])(document, fakeNode);
  return { layer, sync };
}

test('a step Canvas area is outlined in Canvas coordinates, labelled, display-only, and removed when the step has none', () => {
  const h = regionHarness();
  const memo = fakeNode('div', { class: 'egd-canvas-card' }); h.layer.appendChild(memo);
  h.sync([{ x: -40, y: 20, width: 300, height: 200, label: '왼쪽 묶음' }, { x: 400, y: 0, width: 80, height: 60 }]);
  const outlines = h.layer.children.filter(child => child.className === 'egd-briefing-region');
  assert.equal(outlines.length, 2);
  assert.deepEqual(outlines[0].style, { left: '-40px', top: '20px', width: '300px', height: '200px' });
  assert.equal(outlines[0].attributes['aria-hidden'], 'true');
  assert.equal(outlines[0].dataset.testid, 'briefing-region-outline');
  assert.equal(outlines[0].children[0].textContent, '왼쪽 묶음');
  assert.equal(outlines[1].children.length, 0, 'no label, no tag');
  const first = outlines[0];
  h.sync([{ x: -40, y: 20, width: 300, height: 200, label: '왼쪽 묶음' }, { x: 400, y: 0, width: 80, height: 60 }]);
  assert.equal(h.layer.children.includes(first), true, 'an unchanged step keeps its nodes');
  h.sync([]);
  assert.deepEqual(h.layer.children, [memo], 'only the outlines leave; the cards stay');
});

test('closing or changing step goes through syncBriefingFocus, which draws the focus regions', () => {
  const focus = declaration('syncBriefingFocus');
  assert.match(focus, /BriefingState\.briefingStepFocus\(session, resolved, \{ overview: !!session\?\.semanticOverview, cards \}\);\n\s+syncBriefingRegions\(focus\.regions\);/);
  assert.match(declaration('fitBriefingTargets'), /item\.status === 'available' && item\.view\?\.id/, 'a Canvas area first in the list never breaks the camera fit');
});

// ------------------------------------------------ minimap: off-screen marks

const areaBriefing = () => ({ id: 'brief-area', title: '배치', steps: [
  { id: 'one', text: '왼쪽 묶음', targets: [{ canvasRect: { x: -900, y: 0, width: 100, height: 100 }, label: '왼쪽 묶음' }] },
  { id: 'two', text: '근거와 영역', targets: [{ sourceId: 'source-a' }, { canvasRect: { x: 0, y: 0, width: 50, height: 50 } }] },
  { id: 'three', text: '아래', targets: [{ canvasRect: { x: 2000, y: 3000, width: 10, height: 10 } }] },
  { id: 'four', text: '멀리', targets: [{ canvasRect: { x: 9000, y: 0, width: 10, height: 10 } }] },
] });
const at = index => BriefingState.selectBriefingStep(BriefingState.beginBriefing(areaBriefing(), {}), index);
const resolvedAll = session => session.briefing.steps.map(step => BriefingState.resolveBriefingTargets(step));

test('off-screen direction compares a Canvas rectangle with the visible Canvas', () => {
  const viewport = { left: 0, top: 0, right: 1000, bottom: 800 };
  const rect = (x, y, width = 10, height = 10) => ({ x, y, width, height });
  assert.equal(BriefingState.briefingOffscreenDirection(rect(10, 10), viewport), null);
  assert.equal(BriefingState.briefingOffscreenDirection(rect(-5, 10), viewport), null, 'partly visible is on screen');
  assert.equal(BriefingState.briefingOffscreenDirection(rect(-20, 10), viewport), 'left');
  assert.equal(BriefingState.briefingOffscreenDirection(rect(1000, 10), viewport), 'right');
  assert.equal(BriefingState.briefingOffscreenDirection(rect(10, -10), viewport), 'up');
  assert.equal(BriefingState.briefingOffscreenDirection(rect(1200, 900), viewport), 'down-right');
  assert.equal(BriefingState.briefingOffscreenDirection(rect(10, 10), { left: 0, top: 0, right: 0, bottom: 8 }), null);
  assert.equal(BriefingState.briefingOffscreenDirection({ x: 0, y: 0, width: 0, height: 1 }, viewport), null);
  for (const direction of ['left', 'right', 'up', 'down', 'up-left', 'up-right', 'down-left', 'down-right']) assert.ok(BriefingState.BRIEFING_OFFSCREEN_TEXT[direction]);
});

test('the minimap lists the previous, current and next step areas with their off-screen direction', () => {
  const session = at(1), viewport = { left: -100, top: -100, right: 900, bottom: 700 };
  const regions = BriefingState.briefingMinimapRegions(session, resolvedAll(session), { viewport });
  assert.deepEqual(regions.map(region => [region.stepNumber, region.relativeStep, region.areaNumber, region.label, region.offscreen]),
    [[1, -1, 1, '왼쪽 묶음', 'left'], [2, 0, 1, 'Canvas 영역 1', null], [3, 1, 1, 'Canvas 영역 1', 'down-right']]);
  assert.deepEqual(regions[0].rect, { x: -900, y: 0, width: 100, height: 100 });
  assert.equal(regions.some(region => region.stepNumber === 4), false, 'only the neighbouring steps');
  assert.deepEqual(BriefingState.briefingMinimapRegions(session, resolvedAll(session)).map(region => region.offscreen), [null, null, null], 'no viewport, no claim');
  assert.deepEqual(BriefingState.briefingMinimapRegions(null, []), []);
  const foreign = resolvedAll(session).map(list => list.map(item => ({ ...item, target: { ...item.target } })));
  assert.deepEqual(BriefingState.briefingMinimapRegions(session, foreign), [], 'a result for another target object is never used');
});

function minimapHarness({ plan = { markers: [], items: [] }, session, activeThreadId = session.threadId }) {
  const make = (tag, props = {}, ...children) => {
    const node = fakeNode(tag, props, ...children);
    node.replaceChildren = (...nodes) => { node.children = []; nodes.forEach(child => node.appendChild(child)); };
    node.querySelector = () => null;
    node.contains = () => false;
    return node;
  };
  const layer = make('div', { class: 'egd-minimap-briefing-layer' });
  const map = make('div'); map.querySelector = selector => selector === '.egd-minimap-briefing-layer' ? layer : null;
  const list = make('ul');
  const details = make('details'); details.hidden = true; details.querySelector = selector => selector === '.egd-minimap-briefing-list' ? list : null;
  const panel = make('section'); panel.isConnected = false;
  panel.querySelector = selector => selector === '.egd-minimap-map' ? map : selector === '.egd-minimap-briefing' ? details : null;
  const state = { codex: { briefingSession: session, activeThreadId } };
  const names = ['briefingMinimapRegionModel', 'minimapOffscreenText', 'minimapBriefingRegionLabel', 'minimapBriefingEvidenceLabel', 'renderDeskMinimapBriefing'];
  const sources = names.map(declaration);
  assert.ok(sources.every(Boolean), 'production minimap briefing functions exist');
  const render = compileFunction(`${sources.join('\n')}\nreturn renderDeskMinimapBriefing;`,
    ['state', 'document', 'el', 'BriefingState', 'SurfaceState', 'briefingMinimapModel', 'refreshDeskMinimap'])(
    state, { activeElement: null }, make, BriefingState,
    { minimapBox: (rect, model, min) => ({ left: Math.round(model.offsetX + (rect.left - model.bounds.left) * model.scale), top: Math.round(model.offsetY + (rect.top - model.bounds.top) * model.scale),
      width: Math.max(min, Math.round(rect.width * model.scale)), height: Math.max(min, Math.round(rect.height * model.scale)) }) },
    () => plan, () => {});
  return { render, panel, layer, list, details };
}

test('production minimap: step areas sit on the map (on its edge when beyond it), and off-screen targets are marked and named', () => {
  const session = { ...at(1), threadId: 'room' };
  const model = { entities: [{ entity: { id: 'card-a' } }], bounds: { left: -200, top: -200, right: 1000, bottom: 800, width: 1200, height: 1000 },
    viewport: { left: -100, top: -100, right: 900, bottom: 700 }, scale: 0.1, offsetX: 0, offsetY: 0, mapWidth: 120, mapHeight: 100 };
  const entry = { viewId: 'card-a', stepId: 'two', stepNumber: 2, relativeStep: 0, evidenceNumber: 1, current: true, target: { sourceId: 'source-a' }, reference: { label: '주문 표' } };
  const plan = { markers: [{ viewId: 'card-a', x: 1505, y: 50, geometry: { x: 1500, y: 0, width: 10, height: 100 }, entries: [entry] }], items: [entry] };
  const h = minimapHarness({ plan, session });
  h.render(h.panel, model);
  const marker = h.layer.children.find(node => node.dataset.testid === 'minimap-briefing-marker');
  assert.equal(marker.dataset.offscreen, 'true', 'evidence beside the screen is ringed');
  const areas = h.layer.children.filter(node => node.dataset.testid === 'minimap-briefing-region');
  assert.deepEqual(areas.map(node => [node.dataset.stepNumber, node.dataset.offscreen, node.dataset.clamped]),
    [['1', 'true', 'true'], ['2', 'false', 'false'], ['3', 'true', 'true']]);
  assert.deepEqual(areas[0].style, { left: '0px', top: '20px', width: '10px', height: '10px' }, 'beyond the map: on its left edge');
  assert.deepEqual(areas[1].style, { left: '20px', top: '20px', width: '5px', height: '5px' });
  assert.equal(areas[1].children[0].textContent, '2');
  assert.deepEqual(h.list.children.map(row => row.textContent), [
    '현재 2단계 · 열린 근거 1 (목록 순서) · 주문 표 · 범위 미지정 · 화면 밖 오른쪽',
    '이전 1단계 · Canvas 영역 · 왼쪽 묶음 · 화면 밖 왼쪽',
    '현재 2단계 · Canvas 영역 · Canvas 영역 1',
    '다음 3단계 · Canvas 영역 · Canvas 영역 1 · 화면 밖 오른쪽 아래',
  ]);
  assert.equal(h.details.hidden, false);
});

test('production minimap: a briefing of another room shows no areas', () => {
  const session = { ...at(1), threadId: 'room' };
  const model = { entities: [], bounds: { left: 0, top: 0, width: 100, height: 100 }, viewport: { left: 0, top: 0, right: 10, bottom: 10 }, scale: 1, offsetX: 0, offsetY: 0, mapWidth: 100, mapHeight: 100 };
  const shown = minimapHarness({ session });
  shown.render(shown.panel, model);
  assert.equal(shown.layer.children.length, 3);
  const other = minimapHarness({ session, activeThreadId: 'other-room' });
  other.render(other.panel, model);
  assert.equal(other.layer.children.length, 0);
  assert.equal(other.list.children.length, 0);
  assert.equal(other.details.hidden, true);
});
