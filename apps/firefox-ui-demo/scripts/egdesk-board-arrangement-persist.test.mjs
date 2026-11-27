// L4 cycle 3: after an arrangement Apply on Board cards, are the SAVED personal poses (pref egdesk.jointBoard.poses.v1,
// written by the real `pose()` of EGDeskJointBoardView) kept in step with Cmd+Z / Shift+Cmd+Z / panel Undo, does a reload
// (real jointSnapshot over the stored JSON) show what the user last saw, and is the shared Board (server ledger) never written?
// Real source text: installCanvasPlacementOps, arrange wiring, markAgendaDirty (surface) and pose/saveGeometry/boardLayout/findCard
// (JointBoardView) compiled out of the production files. Fakes: DOM nodes, the pref store, the board model. No Firefox/network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, appendFileSync } from 'node:fs';
import * as CanvasLayout from '../overlay/resources/EGDeskCanvasLayout.sys.mjs';
import * as WorkbenchArrange from '../overlay/resources/EGDeskWorkbenchArrange.sys.mjs';
import { jointSnapshot } from '../overlay/resources/EGDeskJointBoardClient.sys.mjs';

const OUT = process.env.L4_MATRIX_OUT;
const record = (id, data) => { if (OUT) appendFileSync(OUT, JSON.stringify({ id, ...data }) + '\n'); };
const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const viewSrc = readFileSync(new URL('../overlay/resources/EGDeskJointBoardView.sys.mjs', import.meta.url), 'utf8');
const sl = surface.split('\n');
const ws = sl.findIndex(l => l.startsWith('  let jointDesk = null,arrangeUI=null;'));
assert.ok(ws >= 0 && sl[ws + 1].startsWith('  const arrange=()=>arrangeUI??='));
const decl = (src, name) => { const s = src.indexOf(`  function ${name}(`); assert.ok(s >= 0, name); return src.slice(s, src.indexOf('\n  }', s) + 4); };

class Node {
  constructor(tag, attrs = {}) { this.tag = tag; this.attrs = { ...attrs }; this.kids = []; this.listeners = {}; this.dataset = {}; this.isConnected = true;
    this.style = { setProperty() {} }; this.parentNode = null; this.hidden = false; this.checked = false; this.disabled = false; this.value = ''; this._text = ''; }
  get id() { return this.attrs.id; } set id(v) { this.attrs.id = v; }
  get classList() { const c = () => String(this.attrs.class || '').split(/\s+/); return { contains: x => c().includes(x), add: x => { this.attrs.class = [...c(), x].join(' '); } }; }
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

const INST = '11111111-1111-4111-8111-111111111111', BOARD_ID = '22222222-2222-4222-8222-222222222222', EPOCH = 'epoch1', OFFSET = { x: 100, y: 50 };
function world({ withCamera = true } = {}) {
  const poses = new Map(), notices = [], keyHandlers = [], http = [], fetches = [];
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
    n.getBoundingClientRect = () => { const p = poses.get(id); return { x: p.x, y: p.y, width: p.width, height: p.height, left: p.x, top: p.y, right: p.x + p.width, bottom: p.y + p.height }; }; return n; };
  const jd = (item, access) => ({ projectionId: 'proj1', jointItem: item, jointLease: access, jointVersion: '1', jointManaged: 'card' });
  // world coordinates include the projection offset; the stored pose is relative to it (pose() subtracts it)
  mk('vA', { x: 140, y: 110, width: 300, height: 200 }, 3, jd('item-A', 'acc-A'));
  mk('vB', { x: 400, y: 190, width: 300, height: 200 }, 4, jd('item-B', 'acc-B'));
  mk('C', { x: 900, y: 500, width: 240, height: 154 }, 2, null);
  const board = { id: BOARD_ID, epoch: EPOCH, title: 't', cards: [
    { id: 'item-A', access: 'acc-A', version: 1, own: true, title: 'A', kind: 'note', layoutVersion: 0 },
    { id: 'item-B', access: 'acc-B', version: 1, own: true, title: 'B', kind: 'note', layoutVersion: 0 }], links: [] };
  const projection = { id: 'proj1', boardId: BOARD_ID, jointAccess: EPOCH, offset: { ...OFFSET }, members: [{ sourceId: 'item-A', viewId: 'vA' }, { sourceId: 'item-B', viewId: 'vB' }] };
  state.boards.projections.proj1 = projection;
  // REAL pose() & friends, compiled from the production JointBoardView source
  const leaseLine = viewSrc.split('\n').find(l => l.trim().startsWith('const lease = '));
  const poseBody = `let view = { instance: INST, boards: [board], singles: [] }, layouts = JSON.parse(prefGet())[INST + '/me'] || {}, instanceScope = INST + '/me';
    const local = JSON.parse(prefGet()); const boards = () => view.boards; const getB = k => boards().find(b => b.id === k || b.id + '' === k);
    ${leaseLine}\n${['boardLayout', 'saveGeometry', 'findCard', 'pose'].map(n => decl(viewSrc, n)).join('\n')}\nreturn pose;`;
  const pose = new Function('board', 'h', 'prefGet', 'INST', poseBody)(board, { geometry: n => ({ ...poses.get(n.id) }), allProjections: () => [projection],
    writeLayout: v => { prefWrites++; prefText = JSON.stringify(v); }, refreshRegion() {} }, () => prefText, INST);
  const JD = { recordPose: pose, presentationBoard: p => p.id === 'proj1' ? { scope: 'board', board } : null, fresh: async () => true };
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
    deskStoreRequest: async (method, path) => { http.push([method, path]); return { status: 503, body: {} }; }, refreshDeskMinimap() {}, ZOOM_MIN: .1, ZOOM_MAX: 4 };
  const body = `${sl[ws]}\njointDesk = JD;\n${sl[ws + 1]}\n${decl(surface, 'markAgendaDirty')}\n${decl(surface, 'installCanvasPlacementOps')}\nreturn { install: installCanvasPlacementOps, arrange };`;
  const real = new Function(...Object.keys(deps), body)(...Object.values(deps));
  real.install(viewport, layer);
  // The user's last saved personal pose (an earlier Desk save): both Board cards were recorded where they stand now.
  JD.recordPose(doc.getElementById('vA')); JD.recordPose(doc.getElementById('vB'));
  const seen = () => ({ cards: ['vA', 'vB', 'C'].map(id => { const p = poses.get(id); return [id, p.x, p.y, p.width, p.height, p.zIndex]; }), cam: { x: state.pan.x, y: state.pan.y, zoom: state.zoom } });
  // What a reload shows: real jointSnapshot over the STORED json; the projection adds its offset on open (h.open(snapshot, epoch, offset)).
  const reloaded = () => { const stored = JSON.parse(prefText); const layout = (stored[INST + '/me'] || {})['b:' + EPOCH] || {};
    const snap = jointSnapshot(INST, board, layout); const off = layout.offset || OFFSET;
    return snap.cards.map(c => [c.id === 'item-A' ? 'vA' : 'vB', c.geometry.x + off.x, c.geometry.y + off.y, c.geometry.width, c.geometry.height, c.geometry.zIndex]); };
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
  const persistedMatchesScreen = () => JSON.stringify(reloaded()) === JSON.stringify(seen().cards.filter(c => c[0] !== 'C'));
  return { state, poses, notices, http, fetches, seen, reloaded, key, arrangeWith, panelUndo, manualMove, persistedMatchesScreen, prefWrites: () => prefWrites, sessionSaves: () => sessionSaves, pref: () => prefText, real };
}
const BASE = (w) => { w.poses.get('vA'); };

test('P0 static: the personal pose path never touches the network or the shared board client', () => {
  for (const n of ['boardLayout', 'saveGeometry', 'pose']) assert.doesNotMatch(decl(viewSrc, n), /\bapi\.|\bfetch\b|request\(|\.send\(/, n);
  const wb = readFileSync(new URL('../overlay/resources/EGDeskWorkbenchArrange.sys.mjs', import.meta.url), 'utf8');
  for (const n of ['commit', 'restore']) { const at = wb.indexOf(` function ${n}(`); assert.ok(at >= 0, n); const rest = wb.slice(at + 5); const end = rest.search(/\n (?:async )?function |\n const /); assert.doesNotMatch(rest.slice(0, end), /h\.http\(|fetch\(/, n); }
});
test('P1 Apply(pair) on Board cards: personal pose saved now equals the screen and a reload shows it; shared board untouched', async () => {
  const w = world(); const s0 = w.seen(); await w.arrangeWith('pair'); const s1 = w.seen();
  assert.notDeepEqual(s1.cards, s0.cards);
  record('P1', { s0: s0.cards, s1: s1.cards, reloaded: w.reloaded(), prefWrites: w.prefWrites(), fetches: w.fetches.length, http: w.http });
  assert.ok(w.persistedMatchesScreen(), 'saved pose == applied layout'); assert.equal(w.fetches.length, 0);
  assert.deepEqual(w.http.filter(([m, p]) => !(m === 'GET' && p === '/decision/status')), []);
});
test('P2 Cmd+Z of the Apply: saved pose reverts too; Shift+Cmd+Z re-saves; reload matches after each', async () => {
  const w = world(); const s0 = w.seen(); await w.arrangeWith('pair'); const s1 = w.seen();
  w.key(); const a = w.seen(); const pa = w.persistedMatchesScreen(); const ra = w.reloaded();
  w.key(true); const b = w.seen(); const pb = w.persistedMatchesScreen(); const rb = w.reloaded();
  record('P2', { s0: s0.cards, s1: s1.cards, undo: a.cards, undoReloaded: ra, redo: b.cards, redoReloaded: rb, pa, pb, fetches: w.fetches.length });
  assert.deepEqual(a.cards, s0.cards); assert.ok(pa, 'after Cmd+Z the saved pose equals the original'); assert.deepEqual(b.cards, s1.cards); assert.ok(pb);
  assert.equal(w.fetches.length, 0);
});
test('P3 panel Undo (top of history, then not top): saved pose follows', async () => {
  const w = world(); const s0 = w.seen(); await w.arrangeWith('pair'); await w.panelUndo(); const a = w.seen();
  record('P3a', { undo: a.cards, reloaded: w.reloaded() }); assert.deepEqual(a.cards, s0.cards); assert.ok(w.persistedMatchesScreen());
  const v = world(); const t0 = v.seen(); await v.arrangeWith('pair'); v.state.canvasLayoutHistory.record({ label: 'move', items: [{ id: 'C', before: { x: 900, y: 500, width: 240, height: 154 }, after: { x: 910, y: 500, width: 240, height: 154 } }] });
  v.poses.set('C', { ...v.poses.get('C'), x: 910 }); await v.panelUndo(); const b = v.seen();
  record('P3b', { undo: b.cards, reloaded: v.reloaded() }); assert.deepEqual(b.cards.slice(0, 2), t0.cards.slice(0, 2)); assert.ok(v.persistedMatchesScreen());
});
test('P4 front (stacking only) Apply, Cmd+Z, Shift+Cmd+Z: saved zIndex follows', async () => {
  const w = world(); const s0 = w.seen(); await w.arrangeWith('front'); const s1 = w.seen(); assert.notDeepEqual(s1.cards, s0.cards);
  const p1 = w.persistedMatchesScreen(); w.key(); const a = w.seen(); const pa = w.persistedMatchesScreen(); w.key(true); const b = w.seen(); const pb = w.persistedMatchesScreen();
  record('P4', { s0: s0.cards, s1: s1.cards, applyPersisted: p1, undo: a.cards, undoPersisted: pa, redo: b.cards, redoPersisted: pb, reloadedAfterUndo: null });
  assert.ok(p1 && pa && pb); assert.deepEqual(a.cards, s0.cards); assert.deepEqual(b.cards, s1.cards);
});
test('P5 manual move of a Board card after Apply, then Cmd+Z: saved pose == screen, reload matches', async () => {
  const w = world(); await w.arrangeWith('pair'); const s1 = w.seen(); w.manualMove('vA', 17); const m = w.seen(); const pm = w.persistedMatchesScreen();
  w.key(); const a = w.seen(); const pa = w.persistedMatchesScreen();
  record('P5', { applied: s1.cards, moved: m.cards, movedPersisted: pm, undoMove: a.cards, undoMovePersisted: pa });
  assert.ok(pm && pa); assert.deepEqual(a.cards, s1.cards);
});
test('P6 camera-only Apply: no pose is written; undo restores the camera only', async () => {
  const w = world(); const writes0 = w.prefWrites(); await w.arrangeWith('overview'); const writes1 = w.prefWrites(); w.key();
  record('P6', { prefWritesDuringApply: writes1 - writes0, cameraAfterUndo: w.seen().cam }); assert.deepEqual(w.seen().cam, { x: 0, y: 0, zoom: 1 });
  assert.ok(w.persistedMatchesScreen());
});
