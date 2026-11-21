import assert from 'node:assert/strict';
import { test } from 'node:test';
import { intersectSpatialRects, readSpatialAudit, spatialSamplePoints, spatialSlot, SPATIAL_AUDIT_LIMITS }
  from '../overlay/resources/EGDeskSpatialAudit.sys.mjs';

const box = (left, top, right, bottom) => ({ left, top, right, bottom });
function fixture() {
  const probes = [];
  const reads = [];
  let probe;
  const document = { defaultView: { getComputedStyle(node) { reads.push(node); return node.css; } },
    elementFromPoint(x, y) { probes.push({ x, y }); return probe(x, y); } };
  const create = (r, parentElement, css) => {
    const attrs = new Map();
    const node = { nodeType: 1, ownerDocument: document, isConnected: true, parentElement,
      getRootNode: () => document, getBoundingClientRect: () => r,
      clientWidth: r.right - r.left, clientHeight: r.bottom - r.top,
      offsetWidth: r.right - r.left, offsetHeight: r.bottom - r.top, clientLeft: 0, clientTop: 0,
      contains(other) { for (let el = other; el; el = el.parentElement) if (el === node) return true; return false; },
      hasAttribute: key => attrs.has(key), getAttribute: key => attrs.get(key),
      matches: s => s === ':disabled' && node.disabled === true,
      attrs, css: { position: 'static', display: 'block', opacity: '1', visibility: 'visible',
        overflowX: 'visible', overflowY: 'visible', pointerEvents: 'auto', ...css } };
    return node;
  };
  const html = create(box(0, 0, 100, 100), null);
  const body = create(box(0, 0, 100, 100), html);
  Object.assign(document, { documentElement: html, body });
  probe = () => body;
  const make = (r, parent = body, css) => create(r, parent, css);
  const audit = (items, isCurrent = () => true) => readSpatialAudit({ document, items, isCurrent });
  return { document, probes, reads, make, body, audit, useProbe: fn => { probe = fn; } };
}
const counts = (target, expected) => {
  for (const [key, value] of Object.entries(expected)) assert.equal(target.samples[key], value, key);
  const { planned, offscreen, clipped, hit, miss, unknown, obscuredHits } = target.samples;
  assert.equal(planned, offscreen + clipped + hit + miss + unknown);
  assert.ok(obscuredHits <= miss);
};

test('pure helpers: stable ephemeral slots, strict AABB edges and thin-strip sample fallback', () => {
  assert.deepEqual([0, 1, 25, 26, 119, 120].map(spatialSlot), ['A', 'B', 'Z', 'AA', 'DP', null]);
  assert.equal(intersectSpatialRects(box(0, 0, 10, 10), box(10, 0, 20, 10)), null);
  assert.deepEqual(intersectSpatialRects(box(0, 0, 10, 10), box(9, 0, 20, 10)), box(9, 0, 10, 10));
  assert.equal(spatialSamplePoints(box(0, 0, 10, 10), box(9, 0, 10, 10)).length, 18);
});

test('AABB overlap is informational; pointer-transparent authorized overlay does not block a hit', () => {
  const f = fixture();
  const a = f.make(box(0, 0, 80, 80));
  const b = f.make(box(0, 0, 80, 80), f.body, { pointerEvents: 'none' });
  f.useProbe(() => a);
  const [front, transparent] = f.audit([{ root: a }, { root: b }]).items;
  assert.deepEqual(front.aabbOverlap, { slots: ['B'], truncated: false });
  counts(front.card, { hit: 9, miss: 0, obscuredHits: 0 });
  assert.equal(transparent.card.pointerEvents, 'none');
  counts(transparent.card, { miss: 9, obscuredHits: 0 });
  assert.ok(transparent.card.warnings.includes('TARGET_POINTER_EVENTS_NONE'));
  assert.equal(transparent.card.knownObscuringSlot, undefined);
});

test('card can be reachable even if its authorized reply target never hits; same-grant blocker slot is optional', () => {
  const f = fixture();
  const a = f.make(box(0, 0, 90, 90));
  const reply = f.make(box(70, 70, 85, 85), a);
  const b = f.make(box(70, 70, 85, 85));
  const bChild = f.make(box(70, 70, 85, 85), b);
  f.useProbe((x, y) => x >= 70 && y >= 70 ? bChild : a);
  const [first] = f.audit([{ root: a, controls: [{ role: 'reply', node: reply }] }, { root: b }]).items;
  const [control] = first.controls;
  assert.equal(first.card.reachability, 'partial-sampled-hit');
  counts(first.card, { hit: 8, miss: 1, obscuredHits: 1 });
  assert.equal(control.reachability, 'no-sampled-hit');
  assert.equal(control.role, 'reply');
  counts(control, { hit: 0, miss: 9, obscuredHits: 9 });
  assert.equal(control.knownObscuringSlot, 'B');
  assert.ok(!f.reads.includes(bChild));
});

test('viewport exclusion and independent overflow clipping, with a narrow visible strip', () => {
  const f = fixture();
  const clip = f.make(box(10, 0, 50, 80), f.body, { overflowX: 'hidden', position: 'relative' });
  const card = f.make(box(-10, 0, 12, 80), clip, { position: 'absolute' });
  f.useProbe(x => x >= 10 ? card : clip);
  const audit = f.audit([{ root: card }]).items[0].card;
  assert.equal(audit.viewport, 'partial');
  assert.equal(audit.overflowClip, 'partial');
  assert.equal(audit.reachability, 'partial-sampled-hit');
  counts(audit, { planned: 18, offscreen: 3, clipped: 6, hit: 9, miss: 0 });
  assert.ok(f.probes.every(p => p.x >= 0 && p.x < 100));
  const off = f.make(box(110, 0, 130, 30));
  const fullyClipped = f.make(box(1, 1, 9, 10), clip);
  const [{ card: offCard }, { card: clipCard }] = f.audit([{ root: off }, { root: fullyClipped }]).items;
  assert.equal(offCard.viewport, 'full');
  assert.equal(offCard.overflowClip, 'inside');
  counts(offCard, { offscreen: 9, clipped: 0 });
  assert.equal(clipCard.viewport, 'inside');
  assert.equal(clipCard.overflowClip, 'full');
  counts(clipCard, { offscreen: 0, clipped: 9 });
});

test('unsupported overflow geometry and actual hits contradicting the model remain unknown', () => {
  const f = fixture();
  const clip = f.make(box(40, 0, 50, 30), f.body, { overflowX: 'hidden' });
  const card = f.make(box(30, 0, 38, 20), clip, { position: 'fixed' });
  f.useProbe(() => card);
  const uncertain = f.audit([{ root: card }]).items[0].card;
  assert.equal(uncertain.overflowClip, 'unknown');
  counts(uncertain, { hit: 9 });
  card.css.position = 'static';
  f.useProbe((x, y) => y < 5 ? card : clip);
  const disagrees = f.audit([{ root: card }]).items[0].card;
  assert.equal(disagrees.overflowClip, 'unknown');
  assert.ok(disagrees.warnings.includes('OVERFLOW_MODEL_DISAGREES_WITH_HIT'));
  assert.ok(!disagrees.warnings.includes('OVERFLOW_FULL'));
  counts(disagrees, { hit: 3, clipped: 0, unknown: 6 });
});

test('hidden, disabled, inert, unmounted and unavailable pointer evidence are distinct', () => {
  const f = fixture();
  const a = f.make(box(0, 0, 90, 90));
  const hidden = f.make(box(0, 0, 20, 20), a, { opacity: '0' });
  const disabled = f.make(box(0, 0, 20, 20), a);
  disabled.disabled = true;
  const inert = f.make(box(0, 0, 20, 20), a);
  inert.attrs.set('inert', '');
  const detached = f.make(box(0, 0, 10, 10), a);
  detached.isConnected = false;
  f.useProbe((x, y) => y < 5 ? disabled : y < 15 ? null : (() => { throw new Error('PRIVATE'); })());
  const { controls } = f.audit([{ root: a, controls: [
    { role: 'reply', node: disabled }, { role: 'open', node: hidden }, { role: 'close', node: inert },
    { role: 'send', node: detached }, { role: 'minimize' },
  ] }]).items[0];
  assert.equal(controls[0].action, 'disabled');
  assert.equal(controls[0].reachability, 'partial-sampled-hit');
  counts(controls[0], { hit: 3, unknown: 6, obscuredHits: 0 });
  assert.equal(controls[1].visibility, 'hidden');
  assert.equal(controls[2].action, 'inert');
  assert.equal(controls[3].mount, 'unmounted');
  assert.equal(controls[4].mount, 'unmounted');
  assert.ok(!JSON.stringify(controls).includes('PRIVATE'));
});

test('arbitrary private hits are indistinguishable at the same probe outcomes; no private fields read', () => {
  const f = fixture();
  const a = f.make(box(0, 0, 80, 80));
  const privateHit = () => {
    const el = f.make(box(1, 2, 3, 4));
    for (const key of ['id', 'tagName', 'textContent', 'className', 'dataset', 'getBoundingClientRect', 'getAttribute', 'css']) {
      Object.defineProperty(el, key, { get: () => assert.fail('inspected a private blocker') });
    }
    return el;
  };
  const first = privateHit(), second = privateHit();
  f.useProbe(() => first);
  const single = f.audit([{ root: a, controls: [{ role: 'PRIVATE INPUT', node: first }] }]);
  f.useProbe((x, y) => (x + y) > 50 ? first : second);
  const multi = f.audit([{ root: a, controls: [{ role: 'PRIVATE INPUT', node: second }] }]);
  assert.deepEqual(single, multi);
  counts(multi.items[0].card, { miss: 9, obscuredHits: 9 });
  assert.equal(multi.items[0].card.knownObscuringSlot, undefined);
  assert.ok(!JSON.stringify(multi).includes('PRIVATE'));
  assert.deepEqual(single.items[0].warnings, ['CONTROL_INPUT_IGNORED']);
});

test('reject duplicate or nested roots and controls outside their own card', () => {
  const f = fixture();
  const a = f.make(box(0, 0, 20, 20));
  const b = f.make(box(0, 0, 20, 20), a);
  const c = f.make(box(0, 0, 20, 20));
  const result = f.audit([{ root: a }, { root: b }, { root: c, controls: [{ role: 'reply', node: b }] }]);
  assert.deepEqual(result.items.slice(0, 2).map(item => item.card.warnings), [['CARD_ROOT_AMBIGUOUS'], ['CARD_ROOT_AMBIGUOUS']]);
  assert.deepEqual(result.items[2].controls[0].warnings, ['CONTROL_OUT_OF_SCOPE']);
});

test('observation fails closed before reads, between collection and sampling, and before return', () => {
  for (const failedCall of [1, 2, 3]) {
    const f = fixture();
    const a = f.make(box(0, 0, 80, 80));
    let calls = 0;
    const result = f.audit([{ root: a }], () => ++calls !== failedCall);
    assert.deepEqual(result, { version: 1, status: 'stale', warnings: ['OBSERVATION_NOT_CURRENT'], items: [] });
    assert.equal(f.probes.length > 0, failedCall === 3);
    if (failedCall === 1) assert.equal(f.reads.length, 0);
  }
  assert.equal(fixture().audit([], () => { throw new Error('not current'); }).status, 'stale');
});

test('bounded item, control, overlap, ancestry, and sample coverage', () => {
  const f = fixture();
  let parent = f.body;
  for (let i = 0; i < 65; i++) parent = f.make(box(0, 0, 80, 80), parent);
  const roots = Array.from({ length: 121 }, () => f.make(box(0, 0, 80, 80), parent));
  const omitted = roots.at(-1);
  f.useProbe(() => omitted);
  const audit = f.audit(roots.map((root, i) => ({ root, controls: i ? [] : Array.from({ length: 9 },
    () => ({ role: 'reply', node: f.make(box(0, 0, 10, 10), root) })) })));
  assert.deepEqual(audit.limits, SPATIAL_AUDIT_LIMITS);
  assert.deepEqual(audit.truncation, { items: true, controls: true, overlaps: true, ancestry: true });
  assert.equal(audit.items.length, 120);
  assert.equal(audit.items.at(-1).slot, 'DP');
  assert.equal(audit.items[0].aabbOverlap.slots.length, 16);
  assert.equal(audit.items[0].aabbOverlap.truncated, true);
  assert.equal(audit.items[0].controls.length, 1);
  assert.ok(audit.warnings.includes('ITEM_LIMIT_REACHED'));
  assert.ok(audit.items[0].warnings.includes('CONTROL_LIMIT_REACHED'));
  assert.ok(audit.items[0].card.warnings.includes('ANCESTOR_LIMIT_REACHED'));
  assert.ok(audit.items.every(item => !item.card.knownObscuringSlot && item.card.samples.planned <= 18));
  assert.ok(!f.reads.includes(omitted));
});
