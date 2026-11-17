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
