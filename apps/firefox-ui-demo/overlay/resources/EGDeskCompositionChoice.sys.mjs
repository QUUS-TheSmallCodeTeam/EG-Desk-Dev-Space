// Local Joint Board composition. The host owns selected scope, access, and all writes.
// Geometry work happens in viewport-relative CSS pixels; landed poses use whole world units.
const READ = [176, 112];
const MAX_LOCAL = 40; // whole-board tidy; never partially arrange a larger selection
const MAX_COMPOSE = 12;
const MARGIN = 10, CLEAR = 3, GAP = 24;
const n = Number.isFinite;
const R = r => r.x + r.width;
const B = r => r.y + r.height;
const X = r => r.x + r.width / 2;
const Y = r => r.y + r.height / 2;
const area = r => r.width * r.height;
const dist = (a, b) => Math.hypot(X(a) - X(b), Y(a) - Y(b));
const clamp = (v, l, h) => Math.max(l, Math.min(h, v));
const overlap = (a, b, gap = 0) => a.x < R(b) + gap && R(a) + gap > b.x && a.y < B(b) + gap && B(a) + gap > b.y;
const hitArea = (a, b) => Math.max(0, Math.min(R(a), R(b)) - Math.max(a.x, b.x)) * Math.max(0, Math.min(B(a), B(b)) - Math.max(a.y, b.y));
const inside = (a, b) => a.x >= b.x && a.y >= b.y && R(a) <= R(b) && B(a) <= B(b);
const pos = (r, x, y) => ({ x, y, width: r.width, height: r.height });
const valid = r => r && [r.x, r.y, r.width, r.height, R(r), B(r)].every(n) && r.width > 0 && r.height > 0;
const same = (a, b) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
const movable = c => c.movable === true && c.pinned === false;
const positive = (value, fallback) => n(value) && value > 0 ? value : fallback;
const order = (a, b) => a.r.y - b.r.y || a.r.x - b.r.x || (a.id < b.id ? -1 : 1);
function cover(rs) {
  const x = Math.min(...rs.map(r => r.x)), y = Math.min(...rs.map(r => r.y));
  return { x, y, width: Math.max(...rs.map(R)) - x, height: Math.max(...rs.map(B)) - y };
}
function context(s, selected, focusId) {
  if (s?.ready === false || !valid(s?.viewport) || !Array.isArray(s?.cards) || !Array.isArray(selected)) return null;
  const { x, y, zoom: z } = s.camera || {};
  if (![x, y, z].every(n) || z <= 0) return null;
  const v = s.viewport, ox = v.x - x, oy = v.y - y;
  if (![ox, oy].every(n)) return null;
  const box = { x: 0, y: 0, width: v.width, height: v.height };
  const safe = { x: MARGIN, y: MARGIN, width: v.width - MARGIN * 2, height: v.height - MARGIN * 2 };
  const project = r => ({ x: r.x * z - ox, y: r.y * z - oy, width: r.width * z, height: r.height * z });
  const world = r => ({ x: Math.round((r.x + ox) / z), y: Math.round((r.y + oy) / z),
    width: Math.round(r.width / z), height: Math.round(r.height / z) });
  const ids = new Set(selected.map(c => typeof c === 'string' ? c : c?.id));
  const cards = [], seen = new Set();
  for (const raw of s.cards) {
    const id = raw?.id;
    if (typeof id !== 'string' || !id || !ids.has(id) || !valid(raw.rect) || raw.canRead === false || raw.visible === false) continue;
    if (seen.has(id)) return null;
    seen.add(id);
    const r = project(raw.rect);
    if (!valid(r)) return null;
    const minW = Math.ceil(positive(raw.minWidth, 230)) * z, minH = Math.ceil(positive(raw.minHeight, 150)) * z;
    cards.push({ id, raw, r, minW, minH, move: movable(raw) });
  }
  if (cards.length !== ids.size || cards.length > MAX_LOCAL) return null;
  cards.sort(order);
  return { box, safe, z, project, world, cards, ids, focus: cards.find(c => c.id === focusId) };
}
function knownLinks(s, c) {
  const links = [], seen = new Map();
  const add = (child, parent, kind) => {
    if (child === parent || !c.ids.has(child) || !c.ids.has(parent) || (kind !== 'waits' && kind !== 'refers')) return;
    if (!seen.has(child)) seen.set(child, new Map());
    const kinds = seen.get(child);
    if (kinds.get(parent) === kind) return;
    kinds.set(parent, kind);
    links.push({ child, parent, kind });
  };
  // A present projection edge list is authoritative even if empty (for example on egress).
  if (Array.isArray(s.links)) {
    for (const e of s.links) if (e) add(e.child, e.parent, e.kind);
  } else {
    for (const { id, raw } of c.cards) if (Array.isArray(raw.links))
      for (const e of raw.links) if (e) add(id, e.id ?? e.parent, e.kind);
  }
  return links;
}
function blockers(s, c) {
  const result = [];
  const add = r => { if (valid(r)) { const p = c.project(r); if (valid(p) && overlap(p, c.box, CLEAR)) result.push(p); } };
  for (const a of s.cards) if (a && !c.ids.has(a.id)) add(a.rect);
  for (const list of [s.obstacles, s.protectedObstacles]) if (Array.isArray(list))
    for (const a of list) add(a?.rect ?? a);
  return result;
}
function land(c, card, r) {
  return same(r, card.r) ? { rect: card.raw.rect, r } : (() => {
    const rect = c.world(r);
    return { rect, r: c.project(rect) };
  })();
}
function certify(c, walls, intents, work) {
  const landed = [], targets = [];
  for (const card of c.cards) {
    const next = intents.get(card.id);
    if (!next) return null;
    const {rect, r} = land(c, card, next);
    const changed = !same(rect, card.raw.rect);
    if (changed && (!card.move || r.width + 1e-6 < card.minW || r.height + 1e-6 < card.minH)) return null;
    if (!valid(r) || !inside(r, changed ? c.safe : c.box) || walls.some(w => overlap(r, w, CLEAR)) ||
        landed.some(o => overlap(r, o, CLEAR)) || (work && overlap(r, work))) return null;
    landed.push(r);
    if (changed) targets.push({ id: card.id, rect });
  }
  if (work && (!inside(work, c.safe) || walls.some(w => overlap(w, work, CLEAR)))) return null;
  return targets.length ? { targets, landed } : null;
}
// Soft terms act only between nearby peers, so tidy never tries to force a grid or compress an intentional gap.
function pairLoss(a, b) {
  if (overlap(a, b)) return 100 + Math.sqrt(hitArea(a, b));
  const gx = Math.max(a.x - R(b), b.x - R(a), 0), gy = Math.max(a.y - B(b), b.y - B(a), 0);
  const gap = Math.hypot(gx, gy);
  let loss = Math.max(0, 16 - gap) * 1.25;
  if (gap < 145) {
    const d = gx >= gy ? Math.min(Math.abs(a.y - b.y), Math.abs(B(a) - B(b)), Math.abs(Y(a) - Y(b))) :
      Math.min(Math.abs(a.x - b.x), Math.abs(R(a) - R(b)), Math.abs(X(a) - X(b)));
    loss += .75 * Math.min(d, 36) * clamp((145 - gap) / 75, 0, 1);
  }
  return loss;
}
function tidy(c, walls) {
  const { cards, safe } = c;
  const p = new Map(cards.map(a => [a.id, a.r]));
  const edge = (r, box) => Math.max(0, box.x - r.x) + Math.max(0, box.y - r.y) +
    Math.max(0, R(r) - R(box)) + Math.max(0, B(r) - B(box));
  const blocked = r => walls.some(w => overlap(r, w, CLEAR));
  const total = () => cards.reduce((sum, a, i) => {
    const r = p.get(a.id);
    let value = 2 * edge(r, c.box) + (blocked(r) ? 350 : 0) + dist(a.r, r) * .33;
    for (let j = 0; j < i; j++) value += pairLoss(r, p.get(cards[j].id));
    return sum + value;
  }, 0);
  const base = total();
  const stride = Math.max(4, c.z);
  const quant = (v, origin) => origin + Math.round((v - origin) / stride) * stride;
  const budget = clamp(Math.min(c.box.width, c.box.height) * .17, 46, 108);
  // Resolve the most constrained cards first; then run a second pass for nearby alignment.
  const ranked = cards.map(a => [a, edge(a.r, c.box) + (blocked(a.r) ? 350 : 0) +
    cards.reduce((sum, b) => sum + (a === b ? 0 : pairLoss(a.r, b.r)), 0)])
    .sort((a, b) => b[1] - a[1] || order(a[0], b[0])).map(([a]) => a);
  for (const list of [ranked, [...ranked].reverse()]) for (const a of list) {
    if (!a.move || a.r.width > safe.width || a.r.height > safe.height || a.r.width + 1e-6 < a.minW || a.r.height + 1e-6 < a.minH) continue;
    const old = p.get(a.id);
    const other = cards.filter(b => a !== b).map(b => p.get(b.id));
    const near = other.filter(o => overlap(o, a.r, budget + 104));
    const localWalls = walls.filter(o => overlap(o, a.r, budget + CLEAR));
    const loss = r => .33 * dist(a.r, r) + 2 * edge(r, c.box) + (blocked(r) ? 350 : 0) +
      other.reduce((sum, o) => sum + pairLoss(r, o), 0);
    let best = old, score = loss(old);
    const xs = new Set([old.x, a.r.x, clamp(a.r.x, safe.x + c.z, R(safe) - a.r.width - c.z)]);
    const ys = new Set([old.y, a.r.y, clamp(a.r.y, safe.y + c.z, B(safe) - a.r.height - c.z)]);
    for (const o of near) {
      for (const v of [o.x, R(o) - a.r.width, X(o) - a.r.width / 2, o.x - a.r.width - GAP, R(o) + GAP]) xs.add(quant(v, a.r.x));
      for (const v of [o.y, B(o) - a.r.height, Y(o) - a.r.height / 2, o.y - a.r.height - GAP, B(o) + GAP]) ys.add(quant(v, a.r.y));
    }
    for (const o of localWalls.slice(0, 16)) {
      xs.add(o.x - a.r.width - CLEAR - c.z); xs.add(R(o) + CLEAR + c.z);
      ys.add(o.y - a.r.height - CLEAR - c.z); ys.add(B(o) + CLEAR + c.z);
    }
    const nearest = (set, from) => [...set].filter(v => Math.abs(v - from) <= budget)
      .sort((a, b) => Math.abs(a - from) - Math.abs(b - from) || a - b).slice(0, cards.length <= MAX_COMPOSE ? 8 : 5);
    for (const x of nearest(xs, a.r.x)) for (const y of nearest(ys, a.r.y)) {
      const {r} = land(c, a, pos(a.r, x, y));
      if (dist(a.r, r) > budget || !inside(r, safe) || localWalls.some(w => overlap(r, w, CLEAR))) continue;
      const value = loss(r);
      if (value < score - 1.5) { best = r; score = value; }
    }
    p.set(a.id, best);
  }
  if (base - total() < 5) return null;
  return certify(c, walls, p);
}
// Ordered, compact secondary shelf. Only this role-specific group uses regular gaps.
function shelf(items, dims, across, gap, vertical) {
  const places = new Map();
  let major = 0, cross = 0, line = 0;
  for (const a of items) {
    const [width, height] = dims.get(a.id);
    const w = vertical ? height : width, h = vertical ? width : height;
    if (w > across) return null;
    if (major && major + w > across) { major = 0; cross += line + gap; line = 0; }
    places.set(a.id, { x: vertical ? cross : major, y: vertical ? major : cross, width, height });
    major += w + gap; line = Math.max(line, h);
  }
  return places;
}
function fitted(c, card, primary, scale, narrow) {
  const { width: w, height: h } = card.r;
  const minW = Math.max(card.minW, READ[0]), minH = Math.max(card.minH, READ[1]);
  const cellW = narrow ? c.safe.width : c.safe.width * (primary ? .66 : .43);
  const cellH = c.safe.height * (primary ? .65 : .55);
  const maxW = primary ? Math.max(minW, Math.min(cellW, Math.max(w * 1.28, narrow ? 310 : 360))) : Math.max(minW, Math.min(cellW, Math.max(minW, w * scale)));
  const maxH = primary ? Math.max(minH, Math.min(cellH, Math.max(h * 1.20, 220))) : Math.max(minH, Math.min(cellH, Math.max(minH, h * scale)));
  const snap = v => Math.ceil(v / c.z) * c.z;
  return [snap(maxW), snap(maxH)];
}
const moved = (old, r) => dist(old, r) + .46 * (Math.abs(old.width - r.width) + Math.abs(old.height - r.height));
function place(c, walls, rel, work, score, best) {
  const group = cover([...rel.values(), ...(work ? [work] : [])]);
  if (group.width > c.safe.width || group.height > c.safe.height) return best;
  const sx = c.safe.x + c.z - group.x, sy = c.safe.y + c.z - group.y;
  const ex = R(c.safe) - c.z - R(group), ey = B(c.safe) - c.z - B(group);
  if (sx > ex || sy > ey) return best;
  const around = rel.get(c.focus.id), fx = c.focus.r.x - around.x, fy = c.focus.r.y - around.y;
  const center = [(sx + ex) / 2, (sy + ey) / 2];
  const pins = c.cards.filter(a => !a.move);
  let candidates;
  if (pins.length) {
    const pin = pins[0], target = rel.get(pin.id);
    candidates = [[pin.r.x - target.x, pin.r.y - target.y]];
  } else {
    const mx = c.cards.reduce((sum, a) => sum + X(a.r) - X(rel.get(a.id)), 0) / c.cards.length;
    const my = c.cards.reduce((sum, a) => sum + Y(a.r) - Y(rel.get(a.id)), 0) / c.cards.length;
    const xs = [fx, mx, center[0], sx, ex], ys = [fy, my, center[1], sy, ey];
    // Existing surfaces may rule out preferred translations. Search a few nearest clearance lines, not an unbounded grid.
    const near = [...walls].sort((a, b) => dist(a, c.focus.r) - dist(b, c.focus.r)).slice(0, 6);
    for (const a of near) {
      xs.push(a.x - R(group) - CLEAR - c.z, R(a) - group.x + CLEAR + c.z);
      ys.push(a.y - B(group) - CLEAR - c.z, B(a) - group.y + CLEAR + c.z);
    }
    const anchors = (list, lo, hi, near) => [...new Set(list.map(v => clamp(Math.round(v / 4) * 4, lo, hi)))].sort((a, b) =>
      Math.abs(a - near) - Math.abs(b - near) || a - b);
    const xx = anchors(xs, sx, ex, fx), yy = anchors(ys, sy, ey, fy);
    candidates = xx.flatMap(x => yy.map(y => [x, y])).sort((a, b) =>
      Math.hypot(a[0] - fx, a[1] - fy) - Math.hypot(b[0] - fx, b[1] - fy)).slice(0, 34);
  }
  for (const [x, y] of candidates) {
    const p = new Map(c.cards.map(a => { const r = rel.get(a.id); return [a.id, pos(r, r.x + x, r.y + y)]; }));
    if (pins.some(a => { const r = p.get(a.id); return Math.abs(r.x - a.r.x) > 1e-6 || Math.abs(r.y - a.r.y) > 1e-6 ||
        Math.abs(r.width - a.r.width) > 1e-6 || Math.abs(r.height - a.r.height) > 1e-6; })) continue;
    for (const a of pins) p.set(a.id, a.r);
    const open = work ? pos(work, work.x + x, work.y + y) : null;
    const next = certify(c, walls, p, open);
    if (!next) continue;
    const value = score(next.landed, open);
    if (value !== null && (!best || value < best.value)) best = { ...next, value };
  }
  return best;
}
function upstream(c, links) {
  const prereq = new Set(), open = new Set(), done = new Set(), ordered = [];
  const parents = new Map(c.cards.map(a => [a.id, []]));
  for (const e of links) if (e.kind === 'waits') parents.get(e.child).push(e.parent);
  const visit = (id, collect) => {
    if (open.has(id)) return false;
    if (done.has(id)) return true;
    open.add(id);
    for (const parent of parents.get(id)) {
      if (collect) prereq.add(parent);
      if (!visit(parent, collect)) return false;
    }
    open.delete(id); done.add(id); ordered.push(id); return true;
  };
  if (!visit(c.focus.id, true) || !prereq.size) return null;
  for (const a of c.cards) if (!visit(a.id, false)) return null;
  const cards = new Map(c.cards.map(a => [a.id, a]));
  return { prep: ordered.filter(id => prereq.has(id)).map(id => cards.get(id)),
    secondary: ordered.filter(id => id !== c.focus.id && !prereq.has(id)).map(id => cards.get(id)) };
}
function handoff(c, walls, links) {
  const roles = upstream(c, links);
  if (!roles) return null;
  let best;
  for (const horizontal of [true, false]) for (const density of [1, .82, .67]) {
    const dims = new Map(c.cards.map(a => [a.id, a.move ? fitted(c, a, a === c.focus, density, !horizontal) : [a.r.width, a.r.height]]));
    const [w, h] = dims.get(c.focus.id);
    const across = horizontal ? Math.min(.78 * c.safe.height, c.safe.height) : Math.min(.92 * c.safe.width, c.safe.width);
    const prep = shelf(roles.prep, dims, across, GAP, horizontal);
    const group = shelf(roles.secondary, dims, across, GAP, horizontal);
    if (!prep || !group) continue;
    const extent = cover([...prep.values()]);
    const offset = (horizontal ? R(extent) : B(extent)) + 36;
    const main = { x: horizontal ? offset : 0, y: horizontal ? 0 : offset, width: w, height: h };
    const rel = new Map([...prep, [c.focus.id, main]]);
    const second = offset + (horizontal ? w : h) + 36;
    for (const [id, r] of group) rel.set(id, pos(r, r.x + (horizontal ? second : 0), r.y + (horizontal ? 0 : second)));
    const direction = horizontal ? (r => r.x) : (r => r.y);
    const secondary = horizontal ? (r => r.y) : (r => r.x);
    // Column-major on wide, row-major on narrow; no role is guessed from kind/title/position.
    const before = (a, b) => direction(a) + 8 < direction(b) ||
      (Math.abs(direction(a) - direction(b)) <= 8 && secondary(a) + 12 < secondary(b));
    const idx = new Map(c.cards.map((a, i) => [a.id, i]));
    const waits = links.filter(e => e.kind === 'waits');
    function quality(rs) {
      const focus = rs[idx.get(c.focus.id)], rest = rs.filter(r => r !== focus);
      const prepRects = roles.prep.map(a => rs[idx.get(a.id)]), auxRects = roles.secondary.map(a => rs[idx.get(a.id)]);
      const fRatio = area(focus) / Math.max(...rest.map(area));
      if (fRatio < 1.22 || !waits.every(e => before(rs[idx.get(e.parent)], rs[idx.get(e.child)])) ||
          !prepRects.every(r => direction(r) + (horizontal ? r.width : r.height) + 22 <= direction(focus)) ||
          !auxRects.every(r => direction(focus) + (horizontal ? focus.width : focus.height) + 22 <= direction(r))) return null;
      const readable = rs.every(r => r.width >= READ[0] - 1e-6 && r.height >= READ[1] - 1e-6);
      return readable ? fRatio : null;
    }
    const baseline = quality(c.cards.map(a => a.r));
    best = place(c, walls, rel, null, rs => {
      const q = quality(rs);
      if (q === null || (baseline !== null && q < baseline + .20)) return null;
      return c.cards.reduce((sum, a, i) => sum + moved(a.r, rs[i]), 0) / c.cards.length - Math.min(q, 2.3) * 34;
    }, best);
  }
  return best;
}
function workbench(c, walls) {
  const source = c.cards.filter(a => a !== c.focus);
  let best;
  for (const layout of ['right', 'left', 'below']) for (const density of [1, .82, .67]) {
    const vertical = layout !== 'below';
    const dims = new Map(c.cards.map(a => [a.id, a.move ? fitted(c, a, a === c.focus, density, !vertical) : [a.r.width, a.r.height]]));
    const [w, h] = dims.get(c.focus.id);
    const short = Math.min(c.box.width, c.box.height), lane = 34;
    // Reserve a real blank action area, not simply the inter-card padding.
    const workW = Math.min(w, clamp(short * .26, 120, 220));
    const workH = clamp(short * .14, 72, 124);
    const extra = shelf(source, dims, vertical ? c.safe.height : c.safe.width, GAP, vertical);
    if (!extra) continue;
    const east = layout === 'right' ? w + lane : 0;
    const west = layout === 'left' && extra.size ? cover([...extra.values()]).width + lane : 0;
    const south = !vertical ? h + lane + workH + GAP : 0;
    const rel = new Map([[c.focus.id, { x: west, y: 0, width: w, height: h }]]);
    for (const [id, r] of extra) rel.set(id, pos(r, r.x + east, r.y + south));
    const work = { x: west, y: h + lane, width: workW, height: workH };
    const idx = c.cards.indexOf(c.focus);
    const original = c.cards.map(a => a.r);
    function quality(rs) {
      const main = rs[idx], others = rs.filter(r => r !== main);
      if (!rs.every(r => inside(r, c.box) && r.width >= READ[0] - 1e-6 && r.height >= READ[1] - 1e-6)) return null;
      const ratio = others.length ? area(main) / Math.max(...others.map(area)) : 1.65;
      if (ratio < 1.30 || main.width < Math.min(270, c.safe.width * .73) || main.height < 170) return null;
      const nearby = others.length ? Math.min(...others.map(r => dist(main, r))) : 0;
      if (others.length && nearby > Math.max(c.box.width, c.box.height) * .57) return null;
      return Math.min(ratio, 2.25) * 84 + Math.sqrt(area(main)) * .55 - nearby * .24;
    }
    const oldWork = pos(work, c.focus.r.x, B(c.focus.r) + lane);
    const baseline = inside(oldWork, c.safe) && !original.some(r => overlap(r, oldWork)) ? quality(original) : null;
    best = place(c, walls, rel, work, rs => {
      const q = quality(rs);
      if (q === null || (baseline !== null && q < baseline + 13)) return null;
      return -q + c.cards.reduce((sum, a, i) => sum + moved(a.r, rs[i]), 0) / c.cards.length * .68;
    }, best);
  }
  return best;
}
/** Pure local candidates. Missing option means no useful certified proposal. */
export function overallPlans(s, cards, focusId) {
  const c = context(s, cards, focusId), plans = {};
  if (!c?.cards.some(a => a.move) || !valid(c.safe)) return plans;
  const walls = blockers(s, c);
  const add = (option, plan) => { if (plan) plans[option] = { option, camera: null, framing: null, targets: plan.targets }; };
  add('tidy', tidy(c, walls));
  if (c.focus && c.cards.length <= MAX_COMPOSE) {
    add('handoff', handoff(c, walls, knownLinks(s, c)));
    add('workbench', workbench(c, walls));
  }
  return plans;
}
const NEUTRAL = Object.freeze({ density: 'sparse', readability: 'mixed', alignment: 'aligned', flow: 'unlinked',
  focus: 'competing', distribution: 'balanced', openSpace: 'room', movement: 'low' });
/** Current selected geometry only. Never read actual candidate feasibility/targets, which can encode private blockers. */
export function describeComposition(s, cards, focusId, _plans) {
  const c = context(s, cards, focusId);
  if (!c?.cards.length) return { ...NEUTRAL };
  const rs = c.cards.map(a => a.r), v = c.box, full = area(v);
  const read = c.cards.filter(({r, minW, minH}) => r.width >= Math.max(READ[0], minW) && r.height >= Math.max(READ[1], minH) &&
    hitArea(r, v) >= area(r) * .88).length;
  // Fixed coarse sampling estimates occupied union, excluding every unselected or protected shape.
  let occupied = 0;
  for (let y = 0; y < 12; y++) for (let x = 0; x < 12; x++) {
    const px = (x + .5) * v.width / 12, py = (y + .5) * v.height / 12;
    if (rs.some(r => px >= r.x && px < R(r) && py >= r.y && py < B(r))) occupied++;
  }
  const density = occupied / 144;
  const zones = [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]];
  const room = zones.some(([x, y]) => {
    const r = { x: x * v.width * .32 + v.width * .02, y: y * v.height * .32 + v.height * .02,
      width: v.width * .30, height: v.height * .30 };
    return r.width >= 110 && r.height >= 74 && !rs.some(a => overlap(a, r));
  });
  const aligned = rs.filter(a => rs.some(b => a !== b && Math.min(Math.abs(a.x - b.x), Math.abs(X(a) - X(b)), Math.abs(R(a) - R(b)),
    Math.abs(a.y - b.y), Math.abs(Y(a) - Y(b)), Math.abs(B(a) - B(b))) < 14)).length;
  const clip = rs.reduce((sum, r) => sum + 1 - hitArea(r, v) / area(r), 0) / rs.length;
  const edgeHeavy = rs.filter(r => X(r) < v.width * .22 || X(r) > v.width * .78 || Y(r) < v.height * .20 || Y(r) > v.height * .80).length;
  const conflicts = rs.filter((a, i) => rs.some((b, j) => i !== j && hitArea(a, b) > Math.min(area(a), area(b)) * .14)).length / rs.length;
  const focus = c.focus?.r;
  const prominent = focus && hitArea(focus, v) > area(focus) * .85 && (rs.length === 1 ||
    area(focus) >= Math.max(...rs.filter(r => r !== focus).map(area)) * 1.22);
  const effort = clip * 2 + conflicts + (rs.length > 1 && aligned < rs.length * .55 ? .38 : 0) + (!room ? .20 : 0);
  return { density: density < .26 ? 'sparse' : density <= .62 ? 'balanced' : 'dense',
    readability: read === rs.length ? 'comfortable' : read === 0 ? 'small' : 'mixed',
    alignment: rs.length === 1 || aligned >= rs.length * .65 ? 'aligned' : 'scattered',
    flow: knownLinks(s, c).length ? 'linked' : 'unlinked', focus: prominent ? 'prominent' : 'competing',
    distribution: edgeHeavy > rs.length * .6 && rs.some(r => area(r) / full < .48) ? 'edge-heavy' : 'balanced',
    openSpace: room ? 'room' : 'limited', movement: effort > .75 ? 'major' : effort > .32 ? 'moderate' : 'low' };
}
