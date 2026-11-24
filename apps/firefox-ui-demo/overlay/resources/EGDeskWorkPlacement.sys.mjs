// Work-surface placement, canvas runtime half. Pure: no DOM, no network, no model, no camera, no focus.
// Why: on an infinite-canvas Desk an Agent's work has to be VISIBLE (a file it inspects is opened in a viewer), and it must not disturb the
// screen anyone is working on: an invited member works with the owner's resources in another part of the owner's space. So "which task goes
// into which active user's which screen" is counted here, by code, from real state, BEFORE anything is asked of the Decision model:
//   who is active and where each is looking (presence), which tasks run and which surfaces they use or need, what is occupied and what is free,
//   and for one surface that must open: the placement OPTIONS (each a real rectangle that already passed the hard rules).
// The Decision model then only picks among opaque option aliases described by closed words (distance class, whose view, relatedness).
// Coordinates, card ids and member ids never leave this module's maps.
//
// Hard rules (code, never the model):
//   1. Nothing is placed or moved inside another active user's current viewport (another = anyone but the task's requester).
//   2. This module has no way to move a camera or take input focus: it returns rectangles. (Contract section 12.)
//   3. User-made cards are never moved. Only a card an Agent made may be offered a move, and only toward its waiting, idle requester.
//   4. Nothing here reads or writes the shared Board ledger: placement is the viewer's own canvas state.
//
// Presence interface (lane L1 implements the multi-user provider to exactly this shape; createSingleUserPresence is the single-user one):
//   presence.snapshot() -> [{ member: opaqueAlias, self: boolean, active: boolean, viewport: { x, y, width, height } (canvas coordinates),
//                             focusCard: alias | null, lastInputAgeMs: number }]

export const WORK_PLACEMENT_PREF = 'egdesk.workPlacement';
/** Default OFF. "advisory": compute and record where a surface WOULD go; the surface still lands where it lands today. */
export const workPlacementMode = value => (value === 'advisory' ? 'advisory' : 'off');

export const PLACEMENT_RULES = Object.freeze({
  gap: 24,            // clear space around a placed surface (the canvas' own 24px rule)
  idleMs: 20_000,     // no input for this long = idle (two attention limits; the same bound the conversation flow uses for a stall)
  nearViews: 0.75,    // "near": closer to the requester's view than this share of the view's larger side
  quietMinViews: 0.5, // "quiet": at least this far from EVERY active view ...
  quietMaxViews: 2,   // ... and not further than this from the requester's view (further is the adjacent work area's job)
  farViews: 3,        // distance classes: in_view, near (< nearViews), far (< farViews), very_far
  step: 96, rings: 24,
  frameGap: 48, frameSteps: 4, // the adjacent work area lattice: the same view-sized frames, 48px apart, that EGDeskAdjacentWorkbench uses
  maxMembers: 8, maxCards: 300, maxTasks: 16, maxOptions: 8,
});
export const SURFACE_KINDS = Object.freeze(['file', 'browser', 'terminal', 'result']);
export const OPTION_KINDS = Object.freeze(['reuse', 'in_requester_view', 'near_requester', 'beside_related', 'quiet', 'adjacent_area']);
export const ATTENTION_KINDS = Object.freeze(['leave', 'point', 'surface_near_requester']);
export const TASK_STATES = Object.freeze(['running', 'waiting_owner', 'finished']);
const CREATORS = new Set(['agent', 'user', 'shared']);
// What the code picks when nobody is asked or the answer is unsure. Never "into the requester's view": that needs a judgment.
const DEFAULT_ORDER = Object.freeze(['reuse', 'beside_related', 'near_requester', 'quiet', 'adjacent_area']);

const finite = r => !!r && [r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0;
const rectOf = r => ({ x: r.x, y: r.y, width: r.width, height: r.height });
const right = r => r.x + r.width, bottom = r => r.y + r.height;
const hits = (a, b, pad = 0) => a.x < right(b) + pad && right(a) + pad > b.x && a.y < bottom(b) + pad && bottom(a) + pad > b.y;
const inside = (a, b) => a.x >= b.x && a.y >= b.y && right(a) <= right(b) && bottom(a) <= bottom(b);
const apart = (a, b) => Math.hypot(Math.max(0, a.x - right(b), b.x - right(a)), Math.max(0, a.y - bottom(b), b.y - bottom(a)));
const side = v => Math.max(v.width, v.height);
const ALIAS = /^[A-Za-z0-9_.:-]{1,64}$/;

/** The interface, checked. Rows that do not fit it are dropped; at most one self. */
export function normalizePresence(list) {
  const out = [], seen = new Set();
  let self = false;
  for (const row of Array.isArray(list) ? list : []) {
    if (out.length >= PLACEMENT_RULES.maxMembers) break;
    if (!row || typeof row.member !== 'string' || !ALIAS.test(row.member) || seen.has(row.member) || !finite(row.viewport)) continue;
    const isSelf = row.self === true && !self;
    if (isSelf) self = true;
    seen.add(row.member);
    out.push({ member: row.member, self: isSelf, active: row.active === true, viewport: rectOf(row.viewport),
      focusCard: typeof row.focusCard === 'string' && row.focusCard ? row.focusCard : null,
      lastInputAgeMs: Number.isFinite(row.lastInputAgeMs) && row.lastInputAgeMs >= 0 ? row.lastInputAgeMs : 0 });
  }
  return out;
}

/** Single-user provider: this window's own camera/viewport and input state, in the shape the multi-user provider will have. */
export function createSingleUserPresence({ viewport, focusCard = () => null, lastInputAt = () => null, now = Date.now, activeWithinMs = 5 * 60_000 } = {}) {
  return Object.freeze({
    snapshot() {
      let view = null, focus = null, at = null;
      try { view = viewport(); } catch { view = null; }
      try { focus = focusCard(); } catch { focus = null; }
      try { at = lastInputAt(); } catch { at = null; }
      if (!finite(view)) return [];
      const age = Number.isFinite(at) ? Math.max(0, now() - at) : 0; // unknown input time: treated as "just now" (active, not idle)
      return [{ member: 'self', self: true, active: age <= activeWithinMs, viewport: rectOf(view), focusCard: typeof focus === 'string' && focus ? focus : null, lastInputAgeMs: age }];
    },
  });
}

/**
 * enumerateWorkScene({ presence, cards, tasks, obstacles }) -> the scene everything else is computed from.
 *   presence: presence.snapshot()
 *   cards: [{ id, rect, kind, creator: 'agent' | 'user' | 'shared' (anything else = unknown, treated as user-made), taskId?, movable? }]
 *   tasks: [{ id, state, requester: member, waiting: [member], ownerMustAct, surfaces: [{ kind, cardId | null }] }]
 *   obstacles: [rect] (Board regions, shapes)
 */
export function enumerateWorkScene({ presence = [], cards = [], tasks = [], obstacles = [] } = {}) {
  const members = normalizePresence(presence).map((m, i) => ({ ...m, alias: 'M' + (i + 1), idle: m.lastInputAgeMs >= PLACEMENT_RULES.idleMs }));
  const self = members.find(m => m.self) ?? null;
  const memberOf = new Map(members.map(m => [m.member, m]));
  const seenCards = new Set();
  const cardList = [];
  for (const c of Array.isArray(cards) ? cards : []) {
    if (cardList.length >= PLACEMENT_RULES.maxCards) break;
    if (!c || typeof c.id !== 'string' || !c.id || seenCards.has(c.id) || !finite(c.rect)) continue;
    seenCards.add(c.id);
    cardList.push({ id: c.id, alias: 'C' + (cardList.length + 1), rect: rectOf(c.rect), kind: typeof c.kind === 'string' ? c.kind : 'other',
      creator: CREATORS.has(c.creator) ? c.creator : 'unknown', taskId: typeof c.taskId === 'string' && c.taskId ? c.taskId : null, movable: c.movable !== false });
  }
  const cardOf = new Map(cardList.map(c => [c.id, c]));
  const taskList = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (taskList.length >= PLACEMENT_RULES.maxTasks) break;
    if (!t || typeof t.id !== 'string' || !t.id || taskList.some(x => x.id === t.id)) continue;
    const requester = memberOf.get(t.requester) ?? self;
    if (!requester) continue;
    const surfaces = (Array.isArray(t.surfaces) ? t.surfaces : []).filter(s => s && SURFACE_KINDS.includes(s.kind)).slice(0, 12)
      .map(s => ({ kind: s.kind, cardId: typeof s.cardId === 'string' && cardOf.has(s.cardId) ? s.cardId : null }));
    taskList.push({ id: t.id, alias: 'K' + (taskList.length + 1), state: TASK_STATES.includes(t.state) ? t.state : 'running', requester: requester.alias,
      waiting: [...new Set((Array.isArray(t.waiting) ? t.waiting : []).map(m => memberOf.get(m)?.alias).filter(Boolean))],
      ownerMustAct: t.ownerMustAct === true, surfaces });
  }
  for (const t of taskList) for (const s of t.surfaces) { const c = s.cardId && cardOf.get(s.cardId); if (c && !c.taskId) c.taskId = t.id; }
  const occupied = [...cardList.map(c => c.rect), ...(Array.isArray(obstacles) ? obstacles : []).filter(finite).map(rectOf)];
  const scene = { members, self: self?.alias ?? null, cards: cardList, tasks: taskList, occupied };
  scene.freeFrames = freeFrames(scene);
  return scene;
}
const memberByAlias = (scene, alias) => scene.members.find(m => m.alias === alias) ?? null;
const activeViews = (scene, except = null) => scene.members.filter(m => m.active && m.alias !== except).map(m => m.viewport);

/** Whole empty view-sized frames next to each active member's view (the adjacent work area lattice), nearest first. Coordinates stay local. */
function freeFrames(scene) {
  const out = [];
  for (const m of scene.members.filter(x => x.active)) {
    const v = m.viewport, dx = v.width + PLACEMENT_RULES.frameGap, dy = v.height + PLACEMENT_RULES.frameGap;
    const first = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1]]; // EGDeskAdjacentWorkbench's own order for the first ring
    const steps = [...first];
    for (let r = 1; r <= PLACEMENT_RULES.frameSteps; r++) for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== r || steps.some(([a, b]) => a === i && b === j)) continue;
      steps.push([i, j]);
    }
    for (const [i, j] of steps) {
      const frame = { x: v.x + i * dx, y: v.y + j * dy, width: v.width, height: v.height };
      if (scene.occupied.some(o => hits(o, frame)) || scene.members.some(x => x.active && hits(x.viewport, frame))) continue;
      out.push({ of: m.alias, step: Math.max(Math.abs(i), Math.abs(j)), rect: frame });
    }
  }
  return out;
}

// A deterministic outward search for a top-left position: rings of `step` around the anchor, nearest candidates first.
function searchSpot(size, anchor, accept) {
  const { step, rings } = PLACEMENT_RULES;
  for (let r = 0; r <= rings; r++) {
    const ring = [];
    for (let i = -r; i <= r; i++) for (let j = -r; j <= r; j++) if (Math.max(Math.abs(i), Math.abs(j)) === r) ring.push([i, j]);
    ring.sort((a, b) => Math.hypot(...a) - Math.hypot(...b) || a[1] - b[1] || a[0] - b[0]);
    for (const [i, j] of ring) {
      const rect = { x: Math.round(anchor.x + i * step), y: Math.round(anchor.y + j * step), width: size.width, height: size.height };
      if (accept(rect)) return rect;
    }
  }
  return null;
}

/** Closed words for where a rectangle is relative to one member's view, and whose views it touches. */
export function describeRect(scene, rect, viewerAlias) {
  const viewer = memberByAlias(scene, viewerAlias);
  const insideView = scene.members.filter(m => hits(m.viewport, rect)).map(m => m.alias);
  if (!viewer) return { distance: 'very_far', direction: 'none', insideView };
  const v = viewer.viewport;
  if (hits(v, rect)) return { distance: 'in_view', direction: 'in_view', insideView };
  const d = apart(rect, v) / side(v);
  const cx = rect.x + rect.width / 2 - (v.x + v.width / 2), cy = rect.y + rect.height / 2 - (v.y + v.height / 2);
  const direction = Math.abs(cx) / v.width >= Math.abs(cy) / v.height ? (cx >= 0 ? 'right' : 'left') : (cy >= 0 ? 'below' : 'above');
  return { distance: d < PLACEMENT_RULES.nearViews ? 'near' : d < PLACEMENT_RULES.farViews ? 'far' : 'very_far', direction, insideView };
}

/** Hard rule 1 for one rectangle: free of cards and obstacles, and outside every active view except the requester's own. */
export function placementAllowed(scene, rect, requesterAlias) {
  return finite(rect) && !scene.occupied.some(o => hits(o, rect, PLACEMENT_RULES.gap)) && !activeViews(scene, requesterAlias).some(v => hits(v, rect));
}

/**
 * placementOptions(scene, { taskId, surface: { kind, size: { width, height }, cardId?, related?: [cardId] } }) -> [{ alias, kind, rect, cardId?, descriptor }]
 * Every option is a real rectangle that already passed the hard rules. An option kind that has no such rectangle is not listed.
 */
export function placementOptions(scene, { taskId, surface } = {}) {
  const task = scene.tasks.find(t => t.id === taskId) ?? null;
  const requester = memberByAlias(scene, task?.requester ?? scene.self);
  if (!requester || !surface || !SURFACE_KINDS.includes(surface.kind) || !(surface.size?.width > 0) || !(surface.size?.height > 0)) return [];
  const size = { width: Math.round(surface.size.width), height: Math.round(surface.size.height) };
  const view = requester.viewport, gap = PLACEMENT_RULES.gap, unit = side(view);
  const allowed = rect => placementAllowed(scene, rect, requester.alias);
  const out = [];
  const add = (kind, rect, extra = {}) => {
    if (!rect || out.length >= PLACEMENT_RULES.maxOptions || out.some(o => o.kind !== 'reuse' && o.rect.x === rect.x && o.rect.y === rect.y)) return;
    out.push({ kind, rect: rectOf(rect), ...extra });
  };
  // reuse: the surface's own card stays where it is (nothing is placed or moved)
  const own = surface.cardId ? scene.cards.find(c => c.id === surface.cardId) : null;
  if (own) add('reuse', own.rect, { cardId: own.id, related: 'same_task' });
  // into the requester's own view: only for a requester who waits for this task and is idle
  if (task?.waiting.includes(requester.alias) && requester.idle) {
    add('in_requester_view', searchSpot(size, { x: view.x + gap, y: view.y + gap }, r => inside(r, view) && allowed(r)), { related: 'none' });
  }
  // just outside the requester's view
  add('near_requester', searchSpot(size, { x: right(view) + gap, y: view.y + gap }, r => !hits(r, view) && allowed(r) && apart(r, view) < PLACEMENT_RULES.nearViews * unit), { related: 'none' });
  // next to a related card: another surface of the same task first, then cards the caller named as related
  const sameTask = task ? scene.cards.filter(c => c.taskId === task.id && c.id !== own?.id) : [];
  const named = (Array.isArray(surface.related) ? surface.related : []).map(id => scene.cards.find(c => c.id === id)).filter(c => c && c.id !== own?.id && !sameTask.includes(c));
  for (const [list, word] of [[sameTask, 'same_task'], [named, 'related']]) {
    for (const c of list) {
      const spots = [{ x: right(c.rect) + gap, y: c.rect.y }, { x: c.rect.x, y: bottom(c.rect) + gap }, { x: c.rect.x - size.width - gap, y: c.rect.y }, { x: c.rect.x, y: c.rect.y - size.height - gap }]
        .map(p => ({ ...p, ...size })).filter(r => !hits(r, view) || (task?.waiting.includes(requester.alias) && requester.idle));
      const spot = spots.find(allowed);
      if (spot) { add('beside_related', spot, { related: word, beside: c.id }); break; }
    }
  }
  // quiet: away from every active view, yet within reach of the requester
  const everyone = activeViews(scene);
  add('quiet', searchSpot(size, { x: right(view) + PLACEMENT_RULES.quietMinViews * unit, y: view.y + gap },
    r => allowed(r) && everyone.every(v => apart(r, v) >= PLACEMENT_RULES.quietMinViews * side(v)) && apart(r, view) <= PLACEMENT_RULES.quietMaxViews * unit), { related: 'none' });
  // the adjacent work area: the nearest wholly empty frame of the requester's lattice
  const frame = scene.freeFrames.find(f => f.of === requester.alias);
  if (frame) { const spot = { x: frame.rect.x + gap, y: frame.rect.y + gap, ...size }; if (inside(spot, frame.rect) && allowed(spot)) add('adjacent_area', spot, { related: 'none', frameStep: frame.step }); }
  return out.map((o, i) => ({ ...o, alias: 'P' + (i + 1), descriptor: { kind: o.kind, ...describeRect(scene, o.rect, requester.alias), related: o.related } }));
}
/** The code's own pick: used when nobody is asked, the answer is unsure, or a picked option stopped being allowed. */
export function defaultOption(options) {
  for (const kind of DEFAULT_ORDER) { const hit = options.find(o => o.kind === kind); if (hit) return hit; }
  return null;
}

const memberRows = scene => scene.members.map(m => ({ alias: m.alias, self: m.self, active: m.active, idle: m.idle }));
const taskRow = task => ({ state: task.state, requester: task.requester, waiting: [...task.waiting], ownerMustAct: task.ownerMustAct });
const describeOnly = d => ({ distance: d.distance, direction: d.direction, insideView: [...d.insideView] });

/**
 * placementRequest(scene, { taskId, surface }, { landed }) -> { dto, options, fallback } or null when there is nothing to choose.
 * dto is the closed, content-free object that may leave the chrome: member aliases with active/idle, the task's state words, option aliases with their
 * closed descriptors, the code's default and (advisory) where the surface lands today in the same words. No id, title, text, path or coordinate.
 */
export function placementRequest(scene, { taskId, surface } = {}, { landed = null } = {}) {
  const task = scene.tasks.find(t => t.id === taskId);
  const options = placementOptions(scene, { taskId, surface });
  const fallback = defaultOption(options);
  if (!task || !options.length || !fallback) return null;
  const dto = { kind: 'placement', surface: surface.kind, members: memberRows(scene), task: taskRow(task),
    options: options.map(o => ({ alias: o.alias, ...o.descriptor })), default: fallback.alias,
    landed: finite(landed) ? describeOnly(describeRect(scene, landed, task.requester)) : null };
  return { dto, options, fallback };
}

/**
 * Attention for a surface that already exists, when the flow changed (a task finished, needs the owner, a requester went idle).
 * attentionRequest(scene, { taskId, cardId, size? }) -> { dto, options, fallback } or null.
 *   leave: always. point: tell the member who must act where the result is (a fact for the conversation flow; nothing moves).
 *   surface_near_requester: move the card next to / into the requester's view. Listed only when the card was made by an Agent, may move, the requester
 *   waits for this task and is idle, and the spot passes hard rule 1. A user-made card never gets this option.
 */
export function attentionRequest(scene, { taskId, cardId } = {}) {
  const task = scene.tasks.find(t => t.id === taskId), card = scene.cards.find(c => c.id === cardId);
  const requester = task && memberByAlias(scene, task.requester), owner = memberByAlias(scene, scene.self);
  if (!task || !card || !requester) return null;
  const actor = task.ownerMustAct && owner ? owner : requester;
  const list = [{ kind: 'leave', descriptor: { kind: 'leave', ...describeOnly(describeRect(scene, card.rect, actor.alias)) } }];
  const where = describeRect(scene, card.rect, actor.alias);
  if (where.distance !== 'in_view') list.push({ kind: 'point', forMember: actor.alias, descriptor: { kind: 'point', ...describeOnly(where), forMember: actor.alias } });
  if (card.creator === 'agent' && card.movable && task.waiting.includes(requester.alias) && requester.idle && !hits(card.rect, requester.viewport)) {
    const scratch = { ...scene, occupied: scene.occupied.filter(o => !(o.x === card.rect.x && o.y === card.rect.y && o.width === card.rect.width && o.height === card.rect.height)) };
    const size = { width: card.rect.width, height: card.rect.height }, view = requester.viewport, gap = PLACEMENT_RULES.gap;
    const spot = searchSpot(size, { x: view.x + gap, y: view.y + gap }, r => inside(r, view) && placementAllowed(scratch, r, requester.alias))
      ?? searchSpot(size, { x: right(view) + gap, y: view.y + gap }, r => !hits(r, view) && placementAllowed(scratch, r, requester.alias) && apart(r, view) < PLACEMENT_RULES.nearViews * side(view));
    if (spot) list.push({ kind: 'surface_near_requester', rect: spot, cardId: card.id, descriptor: { kind: 'surface_near_requester', ...describeOnly(describeRect(scene, spot, requester.alias)), forMember: requester.alias } });
  }
  const options = list.map((o, i) => ({ ...o, alias: 'A' + (i + 1) }));
  // The code's own pick: point when someone must act and cannot see it; otherwise leave. Never a move.
  const fallback = (task.ownerMustAct || task.state !== 'running') && options.find(o => o.kind === 'point') || options[0];
  const dto = { kind: 'attention', surface: SURFACE_KINDS.includes(card.kind) ? card.kind : 'result', members: memberRows(scene), task: taskRow(task),
    card: { creator: card.creator, movable: card.movable && card.creator === 'agent' }, options: options.map(o => ({ alias: o.alias, ...o.descriptor })), default: fallback.alias };
  return { dto, options, fallback, actor: actor.alias };
}

/**
 * settle(build, pick) -> the option to act on, checked against the scene as it is NOW.
 *   build(): a fresh { options, fallback } (placementRequest / attentionRequest over a new scene); pick: { alias, kind } the judge chose from the earlier list.
 * A choice whose kind of place no longer exists (somebody panned there meanwhile) is dropped for the fresh default; one whose spot shifted takes the fresh spot.
 * Returns { option, source: 'decision' | 'revalidated' | 'default' | 'none' }.
 */
export function settle(build, pick) {
  let fresh = null;
  try { fresh = build(); } catch { fresh = null; }
  if (!fresh) return { option: null, source: 'none' };
  // The judge chose a KIND of place. The same kind in the fresh list is what it meant; its rectangle is the fresh one.
  const hit = pick && fresh.options.find(o => o.kind === pick.kind);
  if (!hit) return { option: fresh.fallback, source: pick ? 'revalidated' : 'default' };
  const same = !pick.rect || !hit.rect || (hit.rect.x === pick.rect.x && hit.rect.y === pick.rect.y);
  return { option: hit, source: same ? 'decision' : 'revalidated' };
}

/**
 * placeSurface({ scene: () => sceneInputs, request: { taskId, surface }, judge, deadlineMs }) -> { rect, option, source, dto } | null
 * The whole placement of ONE new surface: options by code, one judgment (judge(dto) -> alias | null, bounded by deadlineMs), then the pick is re-checked
 * against a freshly read scene. The caller opens the surface at rect without activating it; there is nothing here that could move a camera or a focus.
 */
export async function placeSurface({ scene, request, judge = null, deadlineMs = 6000, setTimer = (fn, ms) => setTimeout(fn, ms) } = {}) {
  const read = () => placementRequest(enumerateWorkScene(scene()), request);
  const first = read();
  if (!first) return null;
  let alias = null;
  if (typeof judge === 'function') {
    try { alias = await Promise.race([Promise.resolve(judge(first.dto)), new Promise(resolve => { const t = setTimer(() => resolve(null), Math.max(1, deadlineMs)); t?.unref?.(); })]); } catch { alias = null; }
  }
  const picked = typeof alias === 'string' ? first.options.find(o => o.alias === alias) ?? null : null;
  const settled = settle(read, picked);
  return settled.option ? { rect: rectOf(settled.option.rect), option: settled.option, source: settled.source, dto: first.dto } : null;
}

/** Advisory: what the runtime WOULD do for a surface that is being opened the usual way, in closed words, plus the request for the bridge. */
export function advisoryPlacement({ presence, cards, tasks, obstacles, taskId, surface, landed }) {
  const scene = enumerateWorkScene({ presence, cards, tasks, obstacles });
  const request = placementRequest(scene, { taskId, surface }, { landed });
  if (!request) return null;
  return { dto: request.dto, would: { alias: request.fallback.alias, ...request.fallback.descriptor }, landed: request.dto.landed,
    differs: !request.dto.landed || request.dto.landed.distance !== request.fallback.descriptor.distance || request.dto.landed.direction !== request.fallback.descriptor.direction };
}
