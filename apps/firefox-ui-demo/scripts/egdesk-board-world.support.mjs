// Shared synthetic canvas host for Board journeys (support module, not a test). The surface functions are the real source text of
// eg-desk-surface.uc.js (installCanvasPlacementOps, the arrange wiring lines, markAgendaDirty) and of EGDeskJointBoardView (pose and
// friends), compiled in one scope; the DOM, camera, pref store and board model are minimal fakes. Copied from the cycle-4 journey harness
// and generalised to a card spec so other journeys can reuse it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as CanvasLayout from '../overlay/resources/EGDeskCanvasLayout.sys.mjs';
import { jointSnapshot } from '../overlay/resources/EGDeskJointBoardClient.sys.mjs';
const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const viewSrc = readFileSync(new URL('../overlay/resources/EGDeskJointBoardView.sys.mjs', import.meta.url), 'utf8');
const sl = surface.split('\n');
const ws = sl.findIndex(l => l.startsWith('  let jointDesk = null,arrangeUI=null;'));
assert.ok(ws >= 0 && sl[ws + 1].startsWith('  const arrange=()=>arrangeUI??='));
const decl = (src, name) => { const s = src.indexOf(`  function ${name}(`); assert.ok(s >= 0, name); return src.slice(s, src.indexOf('\n  }', s) + 4); };
export const INST = '11111111-1111-4111-8111-111111111111', BOARD_ID = '22222222-2222-4222-8222-222222222222', EPOCH = 'epoch1', OFFSET = { x: 100, y: 50 };

class Node {
  constructor(tag, attrs = {}) { this.tag = tag; this.attrs = { ...attrs }; this.kids = []; this.listeners = {}; this.dataset = {}; this.isConnected = true;
    this.style = { setProperty() {} }; this.parentNode = null; this.hidden = false; this.checked = false; this.disabled = false; this.value = ''; this._text = ''; }
  get id() { return this.attrs.id; } set id(v) { this.attrs.id = v; }
  get classList() { const c = () => String(this.attrs.class || '').split(/\s+/); return { contains: x => c().includes(x), add: x => { this.attrs.class = [...new Set([...c(), x])].join(' '); }, remove: x => { this.attrs.class = c().filter(y => y !== x).join(' '); } }; }
  get textContent() { return this._text + this.kids.map(k => k.textContent ?? '').join(''); } set textContent(v) { this._text = v; this.kids = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); } getAttribute(k) { return this.attrs[k] ?? null; } hasAttribute(k) { return k in this.attrs; } removeAttribute(k) { delete this.attrs[k]; }
  append(...n) { for (const x of n) { x.parentNode = this; this.kids.push(x); } } appendChild(n) { this.append(n); }
  replaceChildren(...n) { this.kids = []; this.append(...n); }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } removeEventListener() {}
  remove() { if (this.contains(this.ownerDoc?.activeElement)) this.ownerDoc.activeElement = null; this.isConnected = false; this.parentNode?.kids.splice(this.parentNode.kids.indexOf(this), 1); }
  contains(n) { return n === this || this.kids.some(k => k.contains?.(n)); }
  focus() { this.ownerDoc.activeElement = this; }
  walk() { return this.kids.flatMap(k => [k, ...k.walk()]); }
  matches(sel) { return sel.split(',').some(s => { s = s.trim().replace(':scope > ', ''); return s.startsWith('.') && s.split('.').slice(1).every(c => this.classList.contains(c)); }); }
  querySelectorAll(sel) { const m = /^\[data-presentation-control(?:="(.+)")?\]$/.exec(sel);
    return this.walk().filter(n => m ? (m[1] ? n.attrs['data-presentation-control'] === m[1] : 'data-presentation-control' in n.attrs) : n.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getClientRects() { return [1]; }
  fire(t, e = {}) { for (const f of this.listeners[t] || []) f({ target: this, preventDefault() {}, stopPropagation() {}, ...e }); }
}

const DEFAULT_SPEC = { cards: [{ id: 'vA', item: 'item-A', rect: { x: 140, y: 110, width: 300, height: 200 }, z: 3, kind: 'note' }, { id: 'vB', item: 'item-B', rect: { x: 400, y: 190, width: 300, height: 200 }, z: 4, kind: 'note' }],
  others: [{ id: 'C', rect: { x: 900, y: 500, width: 240, height: 154 }, z: 2 }], links: [] };
// spec.cards: Board cards (joint-managed, own); spec.others: non-Board cards on the canvas (obstacles); spec.links: [{ child, parent, kind }] over item ids.
export function world({ WorkbenchArrange, http, grant, spec = DEFAULT_SPEC }) {
  const poses = new Map(), notices = [], keyHandlers = [], httpLog = [], fetches = [];
  let prefText = '{}', prefWrites = 0, sessionSaves = 0;
  const state = { boards: { projections: {} }, boardSelectionRevision: 0, canvasGroups: [], pan: { x: 0, y: 0 }, zoom: 1, panTarget: { x: 0, y: 0 }, zoomTarget: 1,
    agenda: { suppressDirty: false, restoreInProgress: false, dirty: false, dirtyRevision: 0, dirtyReasons: [] },
    setCanvasViewportTarget: ({ pan, zoom }) => { state.pan = { ...pan }; state.panTarget = { ...pan }; state.zoom = zoom; state.zoomTarget = zoom; } };
  const root = new Node('root'), layer = new Node('layer', { id: 'egd-canvas-layer' }), viewport = new Node('viewport');
  root.append(layer);
  const doc = { documentElement: root, activeElement: null, defaultView: null,
    getElementById: id => root.walk().find(n => n.attrs.id === id) || null,
    createElementNS: (_n, tag) => { const n = new Node(tag); n.ownerDoc = doc; return n; },
    querySelectorAll: sel => sel === '.egd-memo-card' ? [] : layer.kids.filter(k => k.isConnected && k.matches('.egd-canvas-card')) };
  const mk = (id, rect, z, data) => { const n = new Node('div', { id, class: 'egd-canvas-card ' + (data ? '' : 'egd-browser-card') }); n.ownerDoc = doc; Object.assign(n.dataset, data || {});
    layer.append(n); poses.set(id, { ...rect, zIndex: z });
    // like the surface's windows: a fold is a class on the card, set through card._setWindowCollapsed (quiet = no dirty mark of its own)
    n._setWindowCollapsed = (v) => { if (v) n.classList.add('egd-card-collapsed'); else n.classList.remove('egd-card-collapsed'); return !!v; };
    n.getBoundingClientRect = () => { const p = poses.get(id); return { x: p.x, y: p.y, width: p.width, height: p.height, left: p.x, top: p.y, right: p.x + p.width, bottom: p.y + p.height }; }; return n; };
  const jd = (item, access) => ({ projectionId: 'proj1', jointItem: item, jointLease: access, jointVersion: '1', jointManaged: 'card' });
  // world coordinates include the projection offset; the stored pose is relative to it (pose() subtracts it)
  for (const c of spec.cards) mk(c.id, c.rect, c.z, jd(c.item, 'acc-' + c.item));
  for (const o of spec.others) mk(o.id, o.rect, o.z, null);
  const board = { id: BOARD_ID, epoch: EPOCH, title: 't', cards: spec.cards.map(c => ({ id: c.item, access: 'acc-' + c.item, version: 1, own: true, title: c.id, kind: c.kind || 'note', layoutVersion: 0 })), links: spec.links.map(l => ({ ...l })) };
  const projection = { id: 'proj1', boardId: BOARD_ID, jointAccess: EPOCH, offset: { ...OFFSET }, members: spec.cards.map(c => ({ sourceId: c.item, viewId: c.id })) };
  state.boards.projections.proj1 = projection;
  // REAL pose() & friends, compiled from the production JointBoardView source
  const leaseLine = viewSrc.split('\n').find(l => l.trim().startsWith('const lease = '));
  const poseBody = `let view = { instance: INST, boards: [board], singles: [] }, layouts = JSON.parse(prefGet())[INST + '/me'] || {}, instanceScope = INST + '/me';
    const local = JSON.parse(prefGet()); const boards = () => view.boards; const getB = k => boards().find(b => b.id === k || b.id + '' === k);
    ${leaseLine}\n${['boardLayout', 'saveGeometry', 'findCard', 'pose'].map(n => decl(viewSrc, n)).join('\n')}\nreturn pose;`;
  const pose = new Function('board', 'h', 'prefGet', 'INST', poseBody)(board, { geometry: n => ({ ...poses.get(n.id) }), allProjections: () => [projection],
    writeLayout: v => { prefWrites++; prefText = JSON.stringify(v); }, refreshRegion() {} }, () => prefText, INST);
  const JD = { recordPose: pose, presentationBoard: p => p.id === 'proj1' ? { scope: 'board', board } : null, fresh: async () => grant() };
  const win = { innerWidth: 1000, innerHeight: 700, requestAnimationFrame: () => 1, setInterval: () => 1, clearInterval() {}, getComputedStyle: () => ({ visibility: 'visible', minWidth: '', minHeight: '' }),
    fetch: async (...a) => { fetches.push(a); throw new Error('no shared-board network in a personal arrangement'); },
    addEventListener(t, f) { if (t === 'keydown') keyHandlers.push(f); }, removeEventListener() {} };
  doc.defaultView = win;
  const persistentEntityGeometry = n => ({ ...poses.get(n.id) });
  const applyPersistentEntityGeometry = (n, g) => { poses.set(n.id, { ...poses.get(n.id), ...g }); };
  const deps = { window: win, document: doc, state, CanvasLayout, WorkbenchArrange, JD, el: (tag, attrs) => new Node(tag, attrs), Element: Node,
    MutationObserver: class { observe() {} disconnect() {} }, registerEscapeLayer() {}, isCardFullscreen: () => false, cardLabelForViewportRail: n => n.id,
    scheduleDeskSessionSave: () => { sessionSaves++; }, observeFileProjectAssociation() {}, refreshBoardRegion() {}, syncViewportAgendaRail() {},
    boardNotice: m => notices.push(m), persistentEntityGeometry, applyPersistentEntityGeometry, ViewportExtras: { snapToggleView: () => ({}) },
    safeViewportRect: () => ({ left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700 }),
    deskStoreRequest: async (method, p, body) => { httpLog.push([method, p]); return http(method, p, body); }, refreshDeskMinimap() {}, ZOOM_MIN: .1, ZOOM_MAX: 4 };
  const body = `${sl[ws]}\njointDesk = JD;\n${sl[ws + 1]}\n${decl(surface, 'markAgendaDirty')}\n${decl(surface, 'installCanvasPlacementOps')}\nreturn { install: installCanvasPlacementOps, arrange };`;
  const real = new Function(...Object.keys(deps), body)(...Object.values(deps));
  real.install(viewport, layer);
  // The user's last saved personal pose (an earlier Desk save): both Board cards were recorded where they stand now.
  for (const c of spec.cards) JD.recordPose(doc.getElementById(c.id));
  const seen = () => ({ cards: [...spec.cards.map(c => c.id), ...spec.others.map(o => o.id)].map(id => { const p = poses.get(id); return [id, p.x, p.y, p.width, p.height, p.zIndex]; }), cam: { x: state.pan.x, y: state.pan.y, zoom: state.zoom } });
  // What a reload shows: real jointSnapshot over the STORED json; the projection adds its offset on open (h.open(snapshot, epoch, offset)).
  const reloaded = () => { const stored = JSON.parse(prefText); const layout = (stored[INST + '/me'] || {})['b:' + EPOCH] || {};
    const snap = jointSnapshot(INST, board, layout); const off = layout.offset || OFFSET;
    return snap.cards.map(c => [spec.cards.find(x => x.item === c.id).id, c.geometry.x + off.x, c.geometry.y + off.y, c.geometry.width, c.geometry.height, c.geometry.zIndex]); };
  const key = (shift = false) => { let handled = false; for (const f of keyHandlers) f({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: shift, key: 'z', isComposing: false, keyCode: 90,
    preventDefault() { handled = true; }, stopImmediatePropagation() {}, target: doc.documentElement }); return handled; };
  const ui = () => root.walk().filter(n => 'data-presentation-control' in n.attrs);
  const control = c => ui().find(n => n.attrs['data-presentation-control'] === c);
  const arrangeWith = async option => { await real.arrange().open('proj1', null); const r = control(option); assert.ok(r && !r.disabled, `option ${option} offered: ${ui().map(n => n.attrs['data-presentation-control'])}`);
    r.checked = true; r.fire('change'); control('apply').fire('click'); };
  const panelUndo = async () => { await real.arrange().open('proj1', null); const b = control('undo'); const o = !!b; if (b) b.fire('click'); real.arrange().close(); return o; };
  const manualMove = (id, dx) => { const b = poses.get(id); const before = { x: b.x, y: b.y, width: b.width, height: b.height };
    assert.ok(state.canvasLayoutHistory.record({ label: 'move', items: [{ id, before, after: { ...before, x: before.x + dx } }] })); applyPersistentEntityGeometry(doc.getElementById(id), { x: before.x + dx }); real.markDirty?.(); JD.recordPose(doc.getElementById(id)); };
  // Persisted layout must equal what is on screen for both Board cards (the non-Board card C is not part of the pose store).
  const persistedMatchesScreen = () => JSON.stringify(reloaded()) === JSON.stringify(seen().cards.filter(c => spec.cards.some(x => x.id === c[0])));
  const collapsedIds = () => [...layer.kids].filter(k => k.isConnected && k.classList.contains('egd-card-collapsed')).map(k => k.id);
  return { collapsedIds, state, poses, notices, httpLog, fetches, JD, doc, control, ui, seen, reloaded, key, arrangeWith, panelUndo, manualMove, persistedMatchesScreen, prefWrites: () => prefWrites, sessionSaves: () => sessionSaves, pref: () => prefText, real };
}

