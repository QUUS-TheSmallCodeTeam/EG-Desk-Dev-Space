import test from 'node:test';
import assert from 'node:assert/strict';
import { overallPlans, describeComposition } from '../overlay/resources/EGDeskCompositionChoice.sys.mjs';

const rect = (x, y, width, height) => ({ x, y, width, height });
const card = (id, x, y, width = 240, height = 154, more = {}) => ({ id, rect: rect(x, y, width, height),
  minWidth: 200, minHeight: 130, movable: true, pinned: false, ...more });
const snap = (cards, more = {}) => ({ ready: true, viewport: rect(0, 0, 1320, 840), camera: { x: 0, y: 0, zoom: 1 },
  cards, obstacles: [], ...more });
const right = r => r.x + r.width, bottom = r => r.y + r.height;
const area = r => r.width * r.height;
const overlaps = (a, b) => a.x < right(b) && right(a) > b.x && a.y < bottom(b) && bottom(a) > b.y;
const screen = (s, r) => rect(r.x * s.camera.zoom + s.camera.x, r.y * s.camera.zoom + s.camera.y,
  r.width * s.camera.zoom, r.height * s.camera.zoom);
const fits = (a, b) => a.x >= b.x && a.y >= b.y && right(a) <= right(b) && bottom(a) <= bottom(b);
const landed = (cards, plan) => Object.fromEntries(cards.map(c => [c.id, plan.targets.find(t => t.id === c.id)?.rect ?? c.rect]));
const edge = (child, parent, kind = 'waits') => ({ child, parent, kind });
const before = (a, b) => right(a) + 22 <= b.x || bottom(a) + 22 <= b.y;
const frozen = v => { if (v && typeof v === 'object') { Object.freeze(v); for (const a of Object.values(v)) frozen(a); } return v; };
function validate(s, cards, plans) {
  for (const [key, plan] of Object.entries(plans)) {
    assert.deepEqual(Object.keys(plan).sort(), ['camera', 'framing', 'option', 'targets']);
    assert.equal(plan.option, key);
    assert.equal(plan.camera, null); assert.equal(plan.framing, null); assert.ok(plan.targets.length);
    const chosen = new Set(cards.map(c => c.id));
    const all = Object.values(landed(cards, plan));
    for (const [i, r] of all.entries()) {
      assert.ok(fits(screen(s, r), s.viewport), `out of view: ${key} ${JSON.stringify(r)}`);
      assert.ok(!all.slice(i + 1).some(other => overlaps(r, other)), `overlap: ${key}`);
      for (const o of [...s.obstacles, ...(s.protectedObstacles ?? []), ...s.cards.filter(c => !chosen.has(c.id)).map(c => c.rect)])
        assert.ok(!overlaps(r, o.rect ?? o), `crossed protected item: ${key}`);
    }
    for (const t of plan.targets) {
      const c = cards.find(a => t.id === a.id);
      assert.ok(c?.movable && !c.pinned, `changed unselected or pinned card: ${t.id}`);
      assert.ok(t.rect.width >= c.minWidth && t.rect.height >= c.minHeight, 'changed a target below its edit minimum');
      assert.ok(Object.values(t.rect).every(Number.isInteger), 'pose must agree with host world rounding');
      assert.notDeepEqual(c.rect, t.rect, 'excluded no-op targets');
    }
  }
}

test('one active card gets a larger edit area and keeps a genuine workspace gap', () => {
  const cards = [card('main', 120, 180)], s = frozen(snap(cards));
  const plans = overallPlans(s, cards, 'main');
  assert.deepEqual(Object.keys(plans), ['workbench']);
  validate(s, cards, plans);
  const r = landed(cards, plans.workbench).main;
  assert.ok(area(r) >= area(cards[0].rect) * 1.35);
  assert.ok(bottom(r) + 34 + 118 <= bottom(s.viewport));
  assert.ok(Math.abs(r.x - cards[0].rect.x) < 100);
  assert.deepEqual(overallPlans(s, cards, 'none'), {});
});

test('tidy improves an already collision-free composition without size changes or distant shuffling', () => {
  const cards = [card('a', 100, 100), card('b', 396, 128), card('distant', 940, 590, 254, 160)];
  const s = frozen(snap(cards));
  assert.ok(!overlaps(cards[0].rect, cards[1].rect));
  const plans = overallPlans(s, cards, 'a');
  assert.ok(plans.tidy); validate(s, cards, plans);
  const at = landed(cards, plans.tidy);
  assert.ok(Math.abs(at.a.y - at.b.y) < 6);
  assert.deepEqual(at.distant, cards[2].rect);
  for (const {id, rect:r} of cards) {
    assert.equal(r.width, at[id].width); assert.equal(r.height, at[id].height);
    assert.ok(Math.hypot(r.x - at[id].x, r.y - at[id].y) <= 30);
  }
  assert.deepEqual(overallPlans(s, [...cards].reverse(), 'a'), plans);
  const aligned = cards.map(c => ({ ...c, rect: at[c.id] }));
  assert.equal(overallPlans(snap(aligned), aligned, 'a').tidy, undefined, 'aligned plans should not re-nudge');
});

test('only accepted waits establish prerequisite reading order; refs remain refs; off-selection or spoofed metadata cannot', () => {
  const cards = [card('focus', 100, 100), card('prep', 396, 128), card('auxiliary', 720, 104)];
  cards[1].title = 'Must be read first';
  const no = snap(cards, { links: [edge('focus', 'prep', 'inferred'), edge('focus', 'hidden')] });
  assert.equal(overallPlans(no, cards, 'focus').handoff, undefined);
  assert.equal(describeComposition(no, cards, 'focus').flow, 'unlinked');
  const refs = snap(cards, { links: [edge('focus', 'prep', 'refers')] });
  assert.equal(overallPlans(refs, cards, 'focus').handoff, undefined);
  assert.equal(describeComposition(refs, cards, 'focus').flow, 'linked');
  const s = snap(cards, { links: [edge('focus', 'prep'), edge('focus', 'auxiliary', 'refers')] });
  const plans = overallPlans(s, cards, 'focus');
  validate(s, cards, plans);
  const p = landed(cards, plans.handoff);
  assert.ok(before(p.prep, p.focus) && before(p.focus, p.auxiliary));
  assert.ok(area(p.focus) >= Math.max(area(p.prep), area(p.auxiliary)) * 1.22);
  assert.equal(overallPlans({ ...s, links: [...s.links, edge('prep', 'focus')] }, cards, 'focus').handoff, undefined);
  assert.equal(overallPlans(s, cards.slice(0, 1), 'focus').handoff, undefined);
  const spoofed = { ...cards[1], links: [{ id: 'focus', kind: 'waits' }] };
  assert.equal(overallPlans({ ...no, cards: [cards[0], spoofed] }, [cards[0], spoofed], 'prep').handoff, undefined);
  assert.ok(overallPlans(snap([cards[0], spoofed]), [cards[0], spoofed], 'prep').handoff);
});

test('wide and narrow switch to different structures without taking the camera', () => {
  const cards = [card('focus', 30, 150, 230, 150), card('source', 40, 400, 240, 150)];
  const s = snap(cards, { viewport: rect(0, 0, 440, 960), links: [edge('focus', 'source')] });
  const plans = overallPlans(s, cards, 'focus');
  assert.ok(plans.handoff && plans.workbench); validate(s, cards, plans);
  const hand = landed(cards, plans.handoff), bench = landed(cards, plans.workbench);
  assert.ok(bottom(hand.source) + 22 < hand.focus.y);
  assert.ok(bottom(bench.focus) + 90 <= bench.source.y, 'workspace separates active editing and supporting material on portrait layouts');
  assert.equal(overallPlans({ ...s, viewport: rect(0, 0, 210, 280) }, cards, 'focus').workbench, undefined);
});

test('pinned anchors retain exact geometry and impossible proposals are omitted rather than dropping a selected edit target', () => {
  const cards = [card('pin', 100, 100, 240, 154, { pinned: true }), card('other', 396, 128)];
  const s = snap(cards);
  const plans = overallPlans(s, cards, 'pin');
  assert.ok(plans.tidy); validate(s, cards, plans);
  assert.deepEqual(landed(cards, plans.tidy).pin, cards[0].rect);
  assert.equal(plans.workbench, undefined, 'small pinned active card cannot be enlarged');
  const fixed = [cards[0], { ...cards[1], movable: false }];
  assert.deepEqual(overallPlans(snap(fixed), fixed, 'pin'), {});
});

test('non-selected private rectangle and protected activity zones constrain only local candidates', () => {
  const cards = [card('focus', 100, 100), card('source', 396, 128)];
  const s = snap(cards, { links: [edge('focus', 'source')] });
  const plain = overallPlans(s, cards, 'focus');
  assert.ok(plain.workbench && plain.handoff);
  const privateCard = card('PRIVATE_FROM_ELSEWHERE', 20, 10, 1300, 745, { canRead: false, pinned: true });
  const blocked = snap([...cards, privateCard], { links: s.links, protectedObstacles: [rect(30, 745, 1220, 60)] });
  const disabled = overallPlans(blocked, cards, 'focus');
  assert.deepEqual(disabled, {});
  assert.deepEqual(describeComposition(blocked, cards, 'focus', disabled), describeComposition(s, cards, 'focus', plain));
  const shifted = snap(cards, { links: s.links, obstacles: [rect(220, 340, 250, 192)] });
  const alternatives = overallPlans(shifted, cards, 'focus');
  assert.ok(alternatives.workbench); validate(shifted, cards, alternatives);
  assert.notDeepEqual(alternatives.workbench, plain.workbench, 'reserved workspace itself checks blockers');
});

test('text readability responds to actual screen size and host edit-size increases; offscreen clipping cannot escape safe viewport', () => {
  const a = card('a', 400, 290, 240, 154), b = card('b', 820, 282, 250, 148);
  const cards = [a,b], standard = snap(cards);
  assert.equal(describeComposition(standard, cards, 'a').readability, 'comfortable');
  const mini = snap(cards, { viewport: rect(42, 35, 870, 680), camera: {x:-35,y:-24,zoom:.48} });
  assert.equal(describeComposition(mini, cards, 'a').readability, 'small');
  const plans = overallPlans(mini, cards, 'a');
  assert.ok(plans.workbench); validate(mini, cards, plans);
  for (const r of Object.values(landed(cards, plans.workbench)).map(r => screen(mini, r))) {
    assert.ok(r.width >= 176 && r.height >= 112);
  }
  const largeText = [{ ...a, minWidth: 420, minHeight: 330 }, b];
  const larger = snap(largeText);
  assert.equal(describeComposition(larger, largeText, 'a').readability, 'mixed');
  const expanded = overallPlans(larger, largeText, 'a');
  assert.ok(expanded.workbench); validate(larger, largeText, expanded);
  const clipped = [card('a', -32, 110), card('b', 340, 154)];
  const clip = snap(clipped);
  const repaired = overallPlans(clip, clipped, 'a');
  assert.ok(repaired.tidy); validate(clip, clipped, repaired);
});

test('1..12 cards are bounded and deterministic; a larger whole-board selection remains local without partial handoff', { timeout: 6000 }, () => {
  const twelve = Array.from({length:12}, (_, i) => card(`card${i}`, 90 + (i % 4) * 310, 76 + Math.floor(i / 4) * 226 + (i % 4) * 9));
  for (let size = 1; size <= 12; size++) {
    const cards = twelve.slice(0, size);
    const s = snap(cards, { viewport: rect(0, 0, 1850, 1120), links: [edge('card0','card1'), edge('card1', 'card2')] });
    const plans = overallPlans(s, cards, 'card0');
    assert.ok(plans.workbench, `no useful workbench at ${size}`); validate(s, cards, plans);
    if (size > 1) assert.ok(plans.handoff, `no handoff at ${size}`);
    assert.deepEqual(overallPlans(s, cards, 'card0'), plans);
  }
  const many = Array.from({length:30}, (_,i) => card(`card${i}`, 90 + (i%6) * 310, 76 + Math.floor(i/6) * 226 + (i%6) * 13));
  const s = snap(many, { viewport: rect(0, 0, 2160, 1320) });
  const plans = overallPlans(s, many, 'card0');
  assert.ok(plans.tidy); assert.deepEqual(Object.keys(plans), ['tidy']); validate(s, many, plans);
});

test('descriptor is a closed enum object; plan details, title, body, unrelated occupancy, and spoofed projection data stay out', () => {
  const cardWithBody = card('SECRET_ID', 100, 100);
  Object.defineProperty(cardWithBody, 'body', { get() { throw new Error('card body must not be read'); } });
  Object.defineProperty(cardWithBody, 'kind', { get() { throw new Error('card kind must not determine roles'); } });
  const second = card('OTHER_ID', 396, 128);
  const cards = [cardWithBody,second], s = snap(cards);
  const desc = describeComposition(s, cards, 'SECRET_ID', { get tidy() { throw new Error('actual plan must not be read'); } });
  const enums = { density:['sparse','balanced','dense'], readability:['small','comfortable','mixed'], alignment:['aligned','scattered'],
    flow:['linked','unlinked'], focus:['prominent','competing'], distribution:['balanced','edge-heavy'],
    openSpace:['room','limited'], movement:['low','moderate','major'] };
  assert.deepEqual(Object.keys(desc), Object.keys(enums));
  for (const [k, v] of Object.entries(desc)) assert.ok(enums[k].includes(v));
  assert.ok(JSON.stringify(desc).length < 180);
  const outside = card('FOREIGN', 175, 245);
  assert.deepEqual(overallPlans(s, [...cards,outside], 'SECRET_ID'), {});
  assert.deepEqual(overallPlans(s, cards, 'SECRET_ID'), overallPlans(s, [card('SECRET_ID',999,999), second], 'SECRET_ID'));
  assert.equal(describeComposition(s, cards, 'SECRET_ID').flow, 'unlinked');
});
