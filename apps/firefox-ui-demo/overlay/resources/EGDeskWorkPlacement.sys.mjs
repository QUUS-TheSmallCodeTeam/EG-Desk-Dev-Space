// Work-surface placement, canvas runtime half. Pure: no DOM, no network, no model, no camera, no focus.
// Why: on an infinite-canvas Desk an Agent's work has to be VISIBLE (a file it inspects is opened in a viewer), and it must not disturb the
// screen anyone is working on: an invited member works with the owner's resources in another part of the owner's space. So "which task goes
// into which active user's which screen" is counted here, by code, from real state, BEFORE anything is asked of the Decision model:
//   who is active and where each is looking (presence), which tasks run and which surfaces they use or need, what is occupied and what is free,
//   and for one surface that must open: the placement OPTIONS (each a real rectangle that already passed the hard rules).
// L1 cycle 12 (real measurement, 2026-11-24: from aliases and closed words alone the model's picks were flat, 0.2-0.5, and missed the
// code's own right answer): WHERE a surface goes is a code rule, decided here from presence and viewports (R3):
//   1. an already-open surface for the same resource (or the surface's own card) is reused: no question;
//   2. a task's next surface goes beside its other surfaces (same task, code knows it);
//   3. the zone, from presence: requester waiting and idle -> in their view (else beside it); requester waiting and working -> beside
//      their view; nobody waiting -> a quiet spot away from every active view; requester unknown (no presence) -> the conservative
//      zone: the adjacent work area of this Desk's own view, outside every known view.
// The Decision model is asked only what code cannot know, as yes/no predicates on real content, each item quoted on its own (R1/R2/R4):
// "is this work about the same matter as this card?" (a nearby card whose text the host may send), to place it beside that card instead,
// and, for a finished task, "does this result need the owner to do something?" (asked by the bridge from the run's own request and answer).
// Coordinates, card ids and member ids never leave this module's maps; a card's label and excerpt leave only when the host marked it maySend.
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
/**
 * Default OFF. The same words as the bridge's EGDESK_WORK_PLACEMENT (advisory | on; anything else is off):
 *   "advisory": compute and record where a surface WOULD go, and send the request to the bridge; the surface still lands where it lands today.
 *   "on" (L1 cycle 13, U7): a NEW work surface opens at the rule's spot (onRuleSpot) instead of today's, without moving any camera and without
 *         taking input focus (the host opens it quietly), never inside another active person's view (hard rule 1), moving no card. Nothing moves
 *         afterwards either. The bridge's "on" adds that a decided pointer becomes a fact the session may turn into one chat message.
 */
export const workPlacementMode = value => (value === 'advisory' || value === 'on' ? value : 'off');

export const PLACEMENT_RULES = Object.freeze({
  gap: 24,            // clear space around a placed surface (the canvas' own 24px rule)
  idleMs: 20_000,     // no input for this long = idle (two attention limits; the same bound the conversation flow uses for a stall)
  nearViews: 0.75,    // "near": closer to the requester's view than this share of the view's larger side
  quietMinViews: 0.75, // "quiet": at least this far from EVERY active view (never closer than "near" ends, so a quiet spot is never described as near) ...
  quietMaxViews: 2,   // ... and not further than this from the requester's view (further is the adjacent work area's job)
  farViews: 3,        // distance classes: in_view, near (< nearViews), far (< farViews), very_far
  step: 96, rings: 24,
  frameGap: 48, frameSteps: 4, // the adjacent work area lattice: the same view-sized frames, 48px apart, that EGDeskAdjacentWorkbench uses
  maxMembers: 8, maxCards: 300, maxTasks: 16, maxOptions: 8,
  maxRelated: 3,      // cards asked about ("the same matter?") per surface: the nearest ones whose text the host may send
  labelChars: 120, excerptChars: 400, resourceChars: 256,
});
/** Which code rule placed a surface (closed words; the bridge re-checks them). */
export const PLACEMENT_RULE_NAMES = Object.freeze(['same_resource', 'same_task', 'requester_idle', 'requester_working', 'nobody_waiting', 'unknown_presence']);
export const SURFACE_KINDS = Object.freeze(['file', 'browser', 'terminal', 'result']);
export const OPTION_KINDS = Object.freeze(['reuse', 'in_requester_view', 'near_requester', 'beside_related', 'quiet', 'adjacent_area']);
export const ATTENTION_KINDS = Object.freeze(['leave', 'point', 'surface_near_requester']);
export const TASK_STATES = Object.freeze(['running', 'waiting_owner', 'finished']);
const CREATORS = new Set(['agent', 'user', 'shared']);
const clean = (text, max) => (typeof text === 'string' ? text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

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
    // A card's words may leave only when the host marked it maySend (the same per-card rule as every other canvas text); else it has no quote.
    const label = c.maySend === true ? clean(c.label, PLACEMENT_RULES.labelChars) : '';
    cardList.push({ id: c.id, alias: 'C' + (cardList.length + 1), rect: rectOf(c.rect), kind: typeof c.kind === 'string' ? c.kind : 'other',
      creator: CREATORS.has(c.creator) ? c.creator : 'unknown', taskId: typeof c.taskId === 'string' && c.taskId ? c.taskId : null, movable: c.movable !== false,
      resource: typeof c.resource === 'string' && c.resource && c.resource.length <= PLACEMENT_RULES.resourceChars ? c.resource : null,
      quote: label ? { label, excerpt: clean(c.excerpt, PLACEMENT_RULES.excerptChars) } : null });
  }
  const cardOf = new Map(cardList.map(c => [c.id, c]));
  const taskList = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (taskList.length >= PLACEMENT_RULES.maxTasks) break;
    if (!t || typeof t.id !== 'string' || !t.id || taskList.some(x => x.id === t.id)) continue;
    // No requester named = the local person. A named requester who is not in the presence snapshot is UNKNOWN (sharing off, gone, another
    // Board): never taken for the local person, so the code places conservatively and protects every view, the local one included.
    const named = typeof t.requester === 'string' && t.requester;
    const requester = named ? memberOf.get(t.requester) ?? null : self;
    if (!requester && !self) continue;
    const surfaces = (Array.isArray(t.surfaces) ? t.surfaces : []).filter(s => s && SURFACE_KINDS.includes(s.kind)).slice(0, 12)
      .map(s => ({ kind: s.kind, cardId: typeof s.cardId === 'string' && cardOf.has(s.cardId) ? s.cardId : null }));
    taskList.push({ id: t.id, alias: 'K' + (taskList.length + 1), state: TASK_STATES.includes(t.state) ? t.state : 'running', requester: requester?.alias ?? null,
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

// The member a task's surfaces are placed for (null: unknown), and the view the code anchors on (the requester's, else this Desk's own).
function anchorOf(scene, task) {
  const requester = task ? (task.requester ? memberByAlias(scene, task.requester) : null) : memberByAlias(scene, scene.self);
  return { requester, anchor: requester ?? memberByAlias(scene, scene.self) };
}
const waitingIdle = (task, m) => !!(task && m && task.waiting.includes(m.alias) && m.idle);

/**
 * placementOptions(scene, { taskId, surface: { kind, size: { width, height }, cardId?, resource? } }) -> [{ alias, kind, rect, cardId?, descriptor }]
 * Every candidate spot of every zone, each a real rectangle that already passed the hard rules. A kind that has no such rectangle is not listed.
 * placementPlan picks among them by rule; nothing here is asked of a model.
 */
export function placementOptions(scene, { taskId, surface } = {}) {
  const task = scene.tasks.find(t => t.id === taskId) ?? null;
  const { requester, anchor } = anchorOf(scene, task);
  if (!anchor || !surface || !SURFACE_KINDS.includes(surface.kind) || !(surface.size?.width > 0) || !(surface.size?.height > 0)) return [];
  const size = { width: Math.round(surface.size.width), height: Math.round(surface.size.height) };
  const view = anchor.viewport, gap = PLACEMENT_RULES.gap, unit = side(view);
  // Hard rule 1. With an unknown requester there is no "own" view: every active view is protected, this Desk's own included.
  const allowed = rect => placementAllowed(scene, rect, requester?.alias ?? null);
  const intoView = waitingIdle(task, requester);
  const out = [];
  const add = (kind, rect, extra = {}) => {
    if (!rect || out.length >= PLACEMENT_RULES.maxOptions || out.some(o => o.kind !== 'reuse' && o.rect.x === rect.x && o.rect.y === rect.y)) return;
    out.push({ kind, rect: rectOf(rect), ...extra });
  };
  // reuse: the surface's own card, or an open card for the same resource, stays where it is (nothing is placed or moved)
  const resource = typeof surface.resource === 'string' && surface.resource ? surface.resource : null;
  const own = (surface.cardId ? scene.cards.find(c => c.id === surface.cardId) : null) ?? (resource ? scene.cards.find(c => c.resource === resource) : null);
  if (own) add('reuse', own.rect, { cardId: own.id, related: 'same_task' });
  // into the requester's own view: only for a requester who waits for this task and is idle
  if (intoView) add('in_requester_view', searchSpot(size, { x: view.x + gap, y: view.y + gap }, r => inside(r, view) && allowed(r)), { related: 'none' });
  // just outside the requester's (or, unknown, this Desk's own) view
  add('near_requester', searchSpot(size, { x: right(view) + gap, y: view.y + gap }, r => !hits(r, view) && allowed(r) && apart(r, view) < PLACEMENT_RULES.nearViews * unit), { related: 'none' });
  // next to another surface of the same task (code knows the task's cards)
  const sameTask = task ? scene.cards.filter(c => c.taskId === task.id && c.id !== own?.id) : [];
  for (const c of sameTask) {
    const spot = besideSpots(c.rect, size).find(r => (!hits(r, view) || intoView) && allowed(r));
    if (spot) { add('beside_related', spot, { related: 'same_task', beside: c.id }); break; }
  }
  // quiet: away from every active view, yet within reach of the anchor view
  const everyone = activeViews(scene);
  add('quiet', searchSpot(size, { x: right(view) + PLACEMENT_RULES.quietMinViews * unit, y: view.y + gap },
    r => allowed(r) && everyone.every(v => apart(r, v) >= PLACEMENT_RULES.quietMinViews * side(v)) && apart(r, view) <= PLACEMENT_RULES.quietMaxViews * unit), { related: 'none' });
  // the adjacent work area: the nearest wholly empty frame of the anchor view's lattice
  const frame = scene.freeFrames.find(f => f.of === anchor.alias);
  if (frame) { const spot = { x: frame.rect.x + gap, y: frame.rect.y + gap, ...size }; if (inside(spot, frame.rect) && allowed(spot)) add('adjacent_area', spot, { related: 'none', frameStep: frame.step }); }
  return out.map((o, i) => ({ ...o, alias: 'P' + (i + 1), descriptor: { kind: o.kind, ...describeRect(scene, o.rect, anchor.alias), related: o.related } }));
}
const besideSpots = (rect, size) => [{ x: right(rect) + PLACEMENT_RULES.gap, y: rect.y }, { x: rect.x, y: bottom(rect) + PLACEMENT_RULES.gap },
  { x: rect.x - size.width - PLACEMENT_RULES.gap, y: rect.y }, { x: rect.x, y: rect.y - size.height - PLACEMENT_RULES.gap }].map(p => ({ ...p, ...size }));

// The zone rules, in order. Each names the kinds it accepts, best first.
const ZONES = Object.freeze({
  requester_idle: ['in_requester_view', 'near_requester', 'quiet', 'adjacent_area'],
  requester_working: ['near_requester', 'quiet', 'adjacent_area'],
  nobody_waiting: ['quiet', 'adjacent_area', 'near_requester'],
  unknown_presence: ['adjacent_area', 'quiet', 'near_requester'],
});
/** The code's rule and its pick among placementOptions: { rule, option } or null when no spot is allowed. */
export function ruleOption(scene, { taskId } = {}, options) {
  const task = scene.tasks.find(t => t.id === taskId) ?? null;
  const { requester } = anchorOf(scene, task);
  const has = kind => options.find(o => o.kind === kind) ?? null;
  if (has('reuse')) return { rule: 'same_resource', option: has('reuse') };
  if (has('beside_related')) return { rule: 'same_task', option: has('beside_related') };
  const rule = !requester ? 'unknown_presence' : !task?.waiting.includes(requester.alias) ? 'nobody_waiting' : requester.idle ? 'requester_idle' : 'requester_working';
  const option = ZONES[rule].map(has).find(Boolean) ?? null;
  return option ? { rule, option } : null;
}
/** Kept for callers of cycle 12-14: the code's own pick (now the rule's). */
export function defaultOption(options, scene = null, request = {}) {
  if (scene) return ruleOption(scene, request, options)?.option ?? null;
  for (const kind of ['reuse', 'beside_related', 'near_requester', 'quiet', 'adjacent_area']) { const hit = options.find(o => o.kind === kind); if (hit) return hit; }
  return null;
}

/**
 * placementPlan(scene, { taskId, surface }) -> { rule, option, options, related } or null.
 * related: up to maxRelated cards that might be about the same matter (nearest to the rule's spot first, each with a spot beside it that passes
 * the hard rules), only cards whose text the host may send, never the task's own. Only when the rule is a zone (reuse and same task are known).
 */
export function placementPlan(scene, { taskId, surface } = {}) {
  const options = placementOptions(scene, { taskId, surface });
  const picked = ruleOption(scene, { taskId }, options);
  if (!picked) return null;
  const task = scene.tasks.find(t => t.id === taskId) ?? null;
  const { requester, anchor } = anchorOf(scene, task);
  const related = [];
  if (!['same_resource', 'same_task'].includes(picked.rule)) {
    const size = { width: Math.round(surface.size.width), height: Math.round(surface.size.height) };
    const intoView = picked.rule === 'requester_idle';
    const ranked = scene.cards.filter(c => c.quote && (!task || c.taskId !== task.id)).sort((a, b) => apart(a.rect, picked.option.rect) - apart(b.rect, picked.option.rect) || a.alias.localeCompare(b.alias));
    for (const c of ranked) {
      if (related.length >= PLACEMENT_RULES.maxRelated) break;
      const spot = besideSpots(c.rect, size).find(r => (!hits(r, anchor.viewport) || intoView) && placementAllowed(scene, r, requester?.alias ?? null));
      if (spot) related.push({ alias: 'R' + (related.length + 1), cardId: c.id, quote: { ...c.quote }, rect: rectOf(spot), descriptor: { kind: 'beside_related', ...describeRect(scene, spot, anchor.alias), related: 'related' } });
    }
  }
  return { rule: picked.rule, option: picked.option, options, related };
}

const memberRows = scene => scene.members.map(m => ({ alias: m.alias, self: m.self, active: m.active, idle: m.idle }));
const describeOnly = d => ({ distance: d.distance, direction: d.direction, insideView: [...d.insideView] });

/**
 * placementRequest(scene, { taskId, surface }, { landed }) -> { dto, plan } or null when no spot is allowed.
 * dto is what may leave the chrome: member aliases with active/idle, the requester's alias (null: unknown), the rule and its pick in closed words,
 * the related cards' quoted label and excerpt (maySend only) with where the spot beside each is, and (advisory) where the surface lands today.
 * No id, path or coordinate.
 */
export function placementRequest(scene, { taskId, surface } = {}, { landed = null } = {}) {
  const plan = placementPlan(scene, { taskId, surface });
  const task = scene.tasks.find(t => t.id === taskId);
  if (!plan || !task) return null;
  const { anchor } = anchorOf(scene, task);
  const dto = { kind: 'placement', surface: surface.kind, members: memberRows(scene), requester: task.requester, rule: plan.rule,
    pick: { kind: plan.option.kind, ...describeOnly(plan.option.descriptor) },
    related: plan.related.map(r => ({ alias: r.alias, label: r.quote.label, excerpt: r.quote.excerpt, ...describeOnly(r.descriptor) })),
    landed: finite(landed) ? describeOnly(describeRect(scene, landed, anchor.alias)) : null };
  return { dto, plan, options: plan.options, fallback: plan.option };
}

/**
 * Attention for a surface that already exists, when the flow changed (a task finished, needs the owner, a requester went idle).
 * attentionRequest(scene, { taskId, cardId }) -> { dto, outcomes: { owner, requester } } or null.
 * Both outcomes are code: for the person who would be told, "leave" when they already see the card, a move next to/into the view of a waiting,
 * idle requester (an Agent-made, movable card only, hard rule 1 for the spot), else "point" (tell them where it is; nothing moves).
 * Which one applies is the bridge's: still running -> nothing; the owner must act (the code knows: waiting_owner) -> the owner's; finished ->
 * the yes/no question "does this result need the owner to do something?" on the run's own request and answer.
 */
export function attentionRequest(scene, { taskId, cardId } = {}) {
  const task = scene.tasks.find(t => t.id === taskId), card = scene.cards.find(c => c.id === cardId);
  const owner = memberByAlias(scene, scene.self);
  if (!task || !card || !owner) return null;
  const requester = task.requester ? memberByAlias(scene, task.requester) : null;
  const outcome = (actor, mayMove) => {
    if (!actor) return { kind: 'leave', descriptor: { kind: 'leave', distance: 'very_far', direction: 'none', insideView: scene.members.filter(m => hits(m.viewport, card.rect)).map(m => m.alias) } };
    const where = describeRect(scene, card.rect, actor.alias);
    if (where.distance === 'in_view') return { kind: 'leave', descriptor: { kind: 'leave', ...describeOnly(where) } };
    if (mayMove && card.creator === 'agent' && card.movable && waitingIdle(task, actor)) {
      const scratch = { ...scene, occupied: scene.occupied.filter(o => !(o.x === card.rect.x && o.y === card.rect.y && o.width === card.rect.width && o.height === card.rect.height)) };
      const size = { width: card.rect.width, height: card.rect.height }, view = actor.viewport, gap = PLACEMENT_RULES.gap;
      const spot = searchSpot(size, { x: view.x + gap, y: view.y + gap }, r => inside(r, view) && placementAllowed(scratch, r, actor.alias))
        ?? searchSpot(size, { x: right(view) + gap, y: view.y + gap }, r => !hits(r, view) && placementAllowed(scratch, r, actor.alias) && apart(r, view) < PLACEMENT_RULES.nearViews * side(view));
      if (spot) return { kind: 'surface_near_requester', rect: spot, cardId: card.id, forMember: actor.alias, descriptor: { kind: 'surface_near_requester', ...describeOnly(describeRect(scene, spot, actor.alias)), forMember: actor.alias } };
    }
    return { kind: 'point', forMember: actor.alias, descriptor: { kind: 'point', ...describeOnly(where), forMember: actor.alias } };
  };
  // The owner is never offered a move (their own view is never entered for them); the requester's outcome may be one.
  const outcomes = { owner: outcome(owner, false), requester: outcome(requester, requester !== owner) };
  const dto = { kind: 'attention', surface: SURFACE_KINDS.includes(card.kind) ? card.kind : 'result', members: memberRows(scene), requester: task.requester,
    state: task.state, ownerMustAct: task.ownerMustAct, card: { creator: card.creator, movable: card.movable && card.creator === 'agent' },
    forOwner: { ...outcomes.owner.descriptor }, forRequester: { ...outcomes.requester.descriptor } };
  return { dto, outcomes };
}

/**
 * settle(build, pick) -> the outcome to act on, checked against the scene as it is NOW.
 *   build(): a fresh placementRequest / attentionRequest. pick: what the bridge decided:
 *     placement { kind, cardId? } (beside_related carries the related card's id) | attention { branch: 'owner' | 'requester', kind }.
 * The fresh rule's own pick replaces a decision whose spot no longer exists; a spot that shifted takes the fresh spot.
 * Returns { option, source: 'decision' | 'rule' | 'revalidated' | 'none' }.
 */
export function settle(build, pick) {
  let fresh = null;
  try { fresh = build(); } catch { fresh = null; }
  if (!fresh) return { option: null, source: 'none' };
  const same = (a, b) => !a?.rect || !b?.rect || (a.rect.x === b.rect.x && a.rect.y === b.rect.y);
  if (fresh.outcomes) {
    const branch = pick?.branch === 'owner' ? 'owner' : 'requester', hit = fresh.outcomes[branch];
    return { option: hit, branch, source: pick && hit.kind === pick.kind && same(hit, pick) ? 'decision' : pick ? 'revalidated' : 'rule' };
  }
  if (pick?.kind === 'beside_related' && pick.cardId) {
    const hit = fresh.plan.related.find(r => r.cardId === pick.cardId);
    if (hit) return { option: { kind: 'beside_related', rect: hit.rect, cardId: hit.cardId, descriptor: hit.descriptor }, source: same(hit, pick) ? 'decision' : 'revalidated' };
    return { option: fresh.plan.option, rule: fresh.plan.rule, source: 'revalidated' };
  }
  const own = fresh.plan.option;
  return { option: own, rule: fresh.plan.rule, source: !pick || (pick.kind === own.kind && same(own, pick)) ? 'rule' : 'revalidated' };
}

/**
 * placeSurface({ scene: () => sceneInputs, request: { taskId, surface }, judge, deadlineMs }) -> { rect, option, source, rule, dto } | null
 * The whole placement of ONE new surface: the rule's spot by code; only when there are related cards, one judgment (judge(dto) -> { kind,
 * related: 'R#' } | null, bounded by deadlineMs), then re-checked against a freshly read scene. The caller opens the surface at rect without
 * activating it; there is nothing here that could move a camera or a focus.
 */
export async function placeSurface({ scene, request, judge = null, deadlineMs = 6000, setTimer = (fn, ms) => setTimeout(fn, ms) } = {}) {
  const read = () => placementRequest(enumerateWorkScene(scene()), request);
  const first = read();
  if (!first) return null;
  let decided = null;
  if (first.dto.related.length && typeof judge === 'function') {
    try { decided = await Promise.race([Promise.resolve(judge(first.dto)), new Promise(resolve => { const t = setTimer(() => resolve(null), Math.max(1, deadlineMs)); t?.unref?.(); })]); } catch { decided = null; }
  }
  const beside = decided?.kind === 'beside_related' ? first.plan.related.find(r => r.alias === decided.related) ?? null : null;
  const settled = settle(read, beside ? { kind: 'beside_related', cardId: beside.cardId, rect: beside.rect } : null);
  return settled.option ? { rect: rectOf(settled.option.rect), option: settled.option, source: settled.source, rule: settled.rule ?? first.plan.rule, dto: first.dto } : null;
}

/** Advisory: what the rule WOULD do for a surface that is being opened the usual way, in closed words, plus the request for the bridge. */
export function advisoryPlacement({ presence, cards, tasks, obstacles, taskId, surface, landed }) {
  const scene = enumerateWorkScene({ presence, cards, tasks, obstacles });
  const request = placementRequest(scene, { taskId, surface }, { landed });
  if (!request) return null;
  const pick = request.dto.pick;
  return { dto: request.dto, would: { rule: request.plan.rule, alias: request.plan.option.alias, ...request.plan.option.descriptor }, landed: request.dto.landed,
    differs: !request.dto.landed || request.dto.landed.distance !== pick.distance || request.dto.landed.direction !== pick.direction,
    // where "on" opens the new surface: the rule's rectangle (already through the hard rules). Not for "reuse": that card exists, nothing new opens.
    spot: request.plan.option.kind === 'reuse' ? null : rectOf(request.plan.option.rect) };
}

/**
 * The placement "on" hands to the host for a NEW surface: the rule's spot, same size, marked quiet (the host must not reveal it with a camera move and
 * must not activate it). inView: whether it lies in this Desk's own view (then nothing would need revealing anyway). null: keep today's placement.
 */
export function onRuleSpot(advisory, landed, ownView) {
  return quietPlacement(advisory?.spot, landed, ownView);
}
/** The same quiet placement for any spot the runtime chose (a rule's spot, or the spot beside a related card after a timely answer). */
export function quietPlacement(spot, landed, ownView) {
  if (!finite(spot) || !finite(landed) || spot.width !== Math.round(landed.width) || spot.height !== Math.round(landed.height)) return null;
  return { x: spot.x, y: spot.y, width: landed.width, height: landed.height, inView: finite(ownView) ? inside(spot, ownView) : false, quiet: true };
}
/**
 * L1 cycle 15, pref "on": how long a surface that can wait (a run's file viewer, which opens asynchronously anyway) waits for the bridge's content answer
 * ("is this work about the same matter as that card?") before it opens: the default Decision deadline. After it, the surface opens at the rule's spot
 * and nothing moves later: an answer that arrives after the deadline is only recorded by the bridge.
 */
export const WORK_PLACEMENT_WAIT_MS = 1500;
export const WORK_PLACEMENT_POLL_MS = 150;
