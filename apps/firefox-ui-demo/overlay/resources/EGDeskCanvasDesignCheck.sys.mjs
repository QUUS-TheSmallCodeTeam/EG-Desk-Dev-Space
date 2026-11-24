// Canvas design check, runtime half. Pure: no DOM, no network, no credentials, no model.
// The Decision model is a system-level judge, not a recommender: this module is where the CANVAS SYSTEM enumerates what can be
// checked (closed item names) and WHERE (location candidates), by code, from real geometry, relations and kinds. The judge only
// answers about those items; the subjective model (Codex/Claude) is the one that redesigns (EGDeskCanvasRedesign.sys.mjs).
// Locations are opaque aliases (A, B, ... for cards, G1, G2, ... for groups): a card or group id never leaves this module's map.
// Cards the user may not send (maySend !== true) or without a known kind are not candidates and are not even counted.

export const CANVAS_CHECK_BARS = Object.freeze({ understandable: .8, flawed: .3, issue: .7, where: .75, margin: .2 }); // placeholders until calibrated
export const MAX_CHECK_CARDS = 12;
export const MAX_CHECK_GROUPS = 6;
const KINDS = new Set(['업무 전표', '메모', '자료', '상태표']);

// Model-facing question text per closed item (what "this issue" means). Not user-facing copy.
export const CANVAS_CHECK_ITEMS = Object.freeze({
  reading_order: 'Does the left-to-right, top-to-bottom reading order contradict the stated before/after relation between the listed cards?',
  related_far: 'Are the listed related cards placed so far apart that a reader would not connect them?',
  overlap: 'Do the listed cards cover each other so that a reader cannot take each in separately?',
  unlabeled_group: 'Is the listed group without a label so that a reader cannot tell why its cards belong together?',
  missing_relation: 'Do the listed cards refer to each other without any visible relation between them?',
  size_inconsistent: 'Do the listed cards of the same kind differ in size so much that their importance reads wrongly?',
  misaligned: 'Are the listed cards almost, but not quite, aligned so that the layout looks accidental?',
  offscreen_important: 'Is the listed important card outside the visible area so that a reader would miss it?',
});
export const CHECK_ITEM_NAMES = Object.freeze(Object.keys(CANVAS_CHECK_ITEMS));

// Computable thresholds (world units). Named so a calibration pass can move them.
export const CHECK_RULES = Object.freeze({ overlapShare: .14, farFactor: 2, sizeRatio: 2.5, nearAlignMin: 3, nearAlignMax: 32, bandFactor: .6 });

const right = r => r.x + r.width, bottom = r => r.y + r.height;
const finite = r => !!r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
const gap = (a, b) => Math.hypot(Math.max(0, a.x - right(b), b.x - right(a)), Math.max(0, a.y - bottom(b), b.y - bottom(a)));
const overlapArea = (a, b) => Math.max(0, Math.min(right(a), right(b)) - Math.max(a.x, b.x)) * Math.max(0, Math.min(bottom(a), bottom(b)) - Math.max(a.y, b.y));
const area = r => r.width * r.height;
const aliasFor = i => String.fromCharCode(65 + i);

function readingRanks(cards) {
  const heights = cards.map(c => c.rect.height).sort((a, b) => a - b);
  const band = Math.max(40, (heights[heights.length >> 1] || 100) * CHECK_RULES.bandFactor);
  const row = c => Math.round((c.rect.y + c.rect.height / 2) / band);
  const order = [...cards].sort((a, b) => row(a) - row(b) || a.rect.x - b.rect.x);
  return new Map(order.map((c, i) => [c.id, i]));
}

/**
 * enumerateCanvasChecks(scene) → { items, cards, groups, locations, idOf, aliasOf }
 * scene: { cards:[{ id, rect, kind, maySend, label?, important?, refs?, inFrame?, movable? }],
 *          groups?:[{ id, viewIds, label? }], links?:[{ child, parent, kind }], capabilities?:{ groupLabels } }
 * items: [{ name, aliases, measure:{ count } }] in a fixed order; an item with no location is not listed.
 */
export function enumerateCanvasChecks(scene = {}) {
  const eligible = (Array.isArray(scene.cards) ? scene.cards : []).filter(c => c && typeof c.id === 'string' && c.maySend === true && KINDS.has(c.kind) && finite(c.rect)).slice(0, MAX_CHECK_CARDS);
  const aliasOf = new Map(eligible.map((c, i) => [c.id, aliasFor(i)]));
  const idOf = new Map([...aliasOf].map(([id, alias]) => [alias, id]));
  const byId = new Map(eligible.map(c => [c.id, c]));
  const A = id => aliasOf.get(id);
  const items = [];
  const add = (name, aliases) => { const unique = [...new Set(aliases)]; if (unique.length) items.push({ name, aliases: unique, measure: { count: unique.length } }); };
  const links = (Array.isArray(scene.links) ? scene.links : []).filter(e => byId.has(e?.child) && byId.has(e?.parent) && e.child !== e.parent);

  const rank = eligible.length ? readingRanks(eligible) : new Map();
  add('reading_order', links.filter(e => e.kind === 'waits' && rank.get(e.child) < rank.get(e.parent)).flatMap(e => [A(e.parent), A(e.child)]));
  add('related_far', links.filter(e => { const a = byId.get(e.parent).rect, b = byId.get(e.child).rect; return gap(a, b) > CHECK_RULES.farFactor * Math.max(a.width, b.width); }).flatMap(e => [A(e.parent), A(e.child)]));
  const overlaps = [];
  for (let i = 0; i < eligible.length; i++) for (let j = i + 1; j < eligible.length; j++) {
    const a = eligible[i].rect, b = eligible[j].rect;
    if (overlapArea(a, b) > Math.min(area(a), area(b)) * CHECK_RULES.overlapShare) overlaps.push(A(eligible[i].id), A(eligible[j].id));
  }
  add('overlap', overlaps);
  const groups = [];
  (Array.isArray(scene.groups) ? scene.groups : []).slice(0, MAX_CHECK_GROUPS).forEach(g => {
    const members = (Array.isArray(g?.viewIds) ? g.viewIds : []).filter(id => byId.has(id));
    if (members.length >= 2) groups.push({ alias: 'G' + (groups.length + 1), id: g.id, size: members.length, labeled: typeof g.label === 'string' && g.label.trim() !== '' });
  });
  // A canvas group that cannot carry a label is not an unlabeled-group finding: nothing could fix it.
  if (scene.capabilities?.groupLabels === true) add('unlabeled_group', groups.filter(g => !g.labeled).map(g => g.alias));
  const linked = new Set(links.map(e => [e.child, e.parent].sort().join('|')));
  const missing = [];
  for (const c of eligible) for (const ref of Array.isArray(c.refs) ? c.refs : []) {
    if (ref !== c.id && byId.has(ref) && !linked.has([c.id, ref].sort().join('|'))) missing.push(A(c.id), A(ref));
  }
  add('missing_relation', missing);
  const sized = [];
  for (const kind of KINDS) {
    const same = eligible.filter(c => c.kind === kind);
    if (same.length < 2) continue;
    const sorted = [...same].sort((a, b) => area(a.rect) - area(b.rect));
    if (area(sorted.at(-1).rect) / area(sorted[0].rect) > CHECK_RULES.sizeRatio) sized.push(A(sorted[0].id), A(sorted.at(-1).id));
  }
  add('size_inconsistent', sized);
  const near = [], d = (a, b) => Math.abs(a - b);
  for (let i = 0; i < eligible.length; i++) for (let j = i + 1; j < eligible.length; j++) {
    const a = eligible[i].rect, b = eligible[j].rect;
    const off = [d(a.x, b.x), d(a.y, b.y)].some(v => v >= CHECK_RULES.nearAlignMin && v <= CHECK_RULES.nearAlignMax);
    if (off) near.push(A(eligible[i].id), A(eligible[j].id));
  }
  add('misaligned', near);
  add('offscreen_important', eligible.filter(c => c.important === true && c.inFrame === false).map(c => A(c.id)));
  const cards = eligible.map(c => ({ alias: A(c.id), id: c.id, kind: c.kind, rect: { x: c.rect.x, y: c.rect.y, width: c.rect.width, height: c.rect.height },
    movable: c.movable === true, ...(typeof c.label === 'string' && c.label.trim() ? { label: c.label } : {}) }));
  const locations = [...new Set([...items.flatMap(i => i.aliases), ...groups.map(g => g.alias).filter(a => items.some(i => i.aliases.includes(a)))])];
  return { items, cards, groups, locations, idOf, aliasOf };
}

const clean = (text, max) => typeof text === 'string' ? text.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '';

/**
 * checkRequestDto(enumeration, { purpose }) → the closed object that may leave the chrome: purpose (<= 280), per candidate card its alias and
 * kind (a short label only when the host supplied one for a card it may send), group sizes, and the items with their alias lists and counts.
 * No ids, no coordinates, no content. Returns null when there is nothing to judge or no usable purpose.
 */
export function checkRequestDto(enumeration, { purpose } = {}) {
  const text = clean(purpose, 280);
  if (!text || !enumeration?.items?.length) return null;
  const used = new Set(enumeration.locations);
  return {
    purpose: text,
    cards: enumeration.cards.map(c => ({ alias: c.alias, kind: c.kind, ...(c.label ? { label: clean(c.label, 40) } : {}) })),
    groups: enumeration.groups.filter(g => used.has(g.alias)).map(g => ({ alias: g.alias, size: g.size })),
    items: enumeration.items.map(i => ({ name: i.name, aliases: [...i.aliases], measure: { count: i.measure.count } })),
  };
}

/** Adapter from the presentation controller's designScene() (+ host extras) to enumerateCanvasChecks input. */
export function sceneFromDesk(desk, { groups = [], important = [], refs = {}, labels = {}, capabilities = {} } = {}) {
  const imp = new Set(important);
  return { links: desk?.links || [], groups, capabilities,
    cards: (desk?.cards || []).map(c => ({ id: c.id, rect: c.rect, kind: c.kind, maySend: c.maySendDescriptor === true, movable: c.movable === true && c.pinned === false,
      inFrame: c.inFrame !== false, important: imp.has(c.id), refs: refs[c.id] || [], ...(labels[c.id] ? { label: labels[c.id] } : {}) })) };
}
