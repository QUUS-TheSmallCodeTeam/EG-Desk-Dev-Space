// L4 cycle 2: global Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z against the REAL surface layout history together with a REAL
// arrangement Apply. The surface functions are the real source text (installCanvasPlacementOps and the arrange wiring line are
// compiled out of eg-desk-surface.uc.js in one shared scope, so the real `arrangeUI` binding and `history` are used); the DOM,
// camera and geometry store are minimal fakes. No Firefox, network or key.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync, appendFileSync } from 'node:fs';
import * as CanvasLayout from '../overlay/resources/EGDeskCanvasLayout.sys.mjs';
import * as WorkbenchArrange from '../overlay/resources/EGDeskWorkbenchArrange.sys.mjs';

const OUT = process.env.L4_MATRIX_OUT;
const record = (id, data) => { if (OUT) appendFileSync(OUT, JSON.stringify({ id, ...data }) + '\n'); };
const source = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const lines = source.split('\n');
const wiringStart = lines.findIndex(l => l.startsWith('  let jointDesk = null,arrangeUI=null;'));
assert.ok(wiringStart >= 0 && lines[wiringStart + 1].startsWith('  const arrange=()=>arrangeUI??='), 'arrange wiring lines found');
const decl = name => { const s = source.indexOf(`  function ${name}(`); assert.ok(s >= 0, name); return source.slice(s, source.indexOf('\n  }', s) + 4); };

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
  remove() { if (this.contains(this.ownerDoc?.activeElement)) this.ownerDoc.activeElement = null; /* like a browser: focus returns to body */ this.isConnected = false; this.parentNode?.kids.splice(this.parentNode.kids.indexOf(this), 1); }
  contains(n) { return n === this || this.kids.some(k => k.contains?.(n)); }
  focus() { this.ownerDoc.activeElement = this; }
  walk() { return this.kids.flatMap(k => [k, ...k.walk()]); }
  matches(sel) { return sel.split(',').some(s => { s = s.trim().replace(':scope > ', '');
    return s.split('.').slice(1).every(c => this.classList.contains(c)) && s.startsWith('.'); }); }
  querySelectorAll(sel) { const m = /^\[data-presentation-control(?:="(.+)")?\]$/.exec(sel);
    return this.walk().filter(n => m ? (m[1] ? n.attrs['data-presentation-control'] === m[1] : 'data-presentation-control' in n.attrs) : n.matches(sel)); }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getClientRects() { return [1]; }
  fire(t, e = {}) { for (const f of this.listeners[t] || []) f({ target: this, preventDefault() {}, stopPropagation() {}, ...e }); }
}

function world({ extra = false } = {}) {
  const poses = new Map(), notices = [], keyHandlers = [];
  const state = { boards: { projections: {} }, boardSelectionRevision: 0, canvasGroups: [], pan: { x: 0, y: 0 }, zoom: 1, panTarget: { x: 0, y: 0 }, zoomTarget: 1,
    setCanvasViewportTarget: ({ pan, zoom }) => { state.pan = { ...pan }; state.panTarget = { ...pan }; state.zoom = zoom; state.zoomTarget = zoom; } };
  const root = new Node('root'), layer = new Node('layer', { id: 'egd-canvas-layer' }), viewport = new Node('viewport');
  root.append(layer);
  const doc = { documentElement: root, activeElement: null, defaultView: null,
    getElementById: id => root.walk().find(n => n.attrs.id === id) || null,
    createElementNS: (_n, tag) => { const n = new Node(tag); n.ownerDoc = doc; return n; },
    querySelectorAll: sel => sel === '.egd-memo-card' ? memos : layer.kids.filter(k => k.isConnected && k.matches('.egd-canvas-card')) };
  const memos = [];
  const mk = (id, rect, z, memo) => { const n = new Node('div', { id, class: `egd-canvas-card ${memo ? 'egd-memo-card' : 'egd-browser-card'}` }); n.ownerDoc = doc;
    layer.append(n); poses.set(id, { ...rect, zIndex: z });
    n.getBoundingClientRect = () => { const p = poses.get(id); return { x: p.x, y: p.y, width: p.width, height: p.height, left: p.x, top: p.y, right: p.x + p.width, bottom: p.y + p.height }; };
    if (memo) { n._memoRecord = { id, seq: 1, text: 'synthetic', updatedAt: 1 }; memos.push(n); } return n; };
  mk('A', { x: 40, y: 60, width: 300, height: 200 }, 3, true); mk('B', { x: 300, y: 140, width: 300, height: 200 }, 4, true);
  mk('C', { x: 900, y: 500, width: 240, height: 154 }, 2, false);
  const win = { innerWidth: 1000, innerHeight: 700, requestAnimationFrame: () => 1, setInterval: () => 1, clearInterval() {}, getComputedStyle: () => ({ visibility: 'visible', minWidth: '', minHeight: '' }),
    addEventListener(t, f) { if (t === 'keydown') keyHandlers.push(f); }, removeEventListener() {} };
  doc.defaultView = win;
  const persistentEntityGeometry = n => ({ ...poses.get(n.id) });
  const applyPersistentEntityGeometry = (n, g) => { const old = poses.get(n.id); poses.set(n.id, { ...old, ...g }); };
  const deps = { window: win, document: doc, state, CanvasLayout, WorkbenchArrange, el: (tag, attrs) => new Node(tag, attrs), Element: Node,
    MutationObserver: class { observe() {} disconnect() {} }, registerEscapeLayer() {}, isCardFullscreen: () => false, cardLabelForViewportRail: n => n.id,
    markAgendaDirty() {}, scheduleDeskSessionSave() {}, boardNotice: m => notices.push(m), persistentEntityGeometry, applyPersistentEntityGeometry,
    ViewportExtras: { snapToggleView: () => ({}) }, safeViewportRect: () => ({ left: 0, top: 0, right: 1000, bottom: 700, width: 1000, height: 700 }),
    deskStoreRequest: async () => ({ status: 503, body: {} }), refreshBoardRegion() {}, refreshDeskMinimap() {}, ZOOM_MIN: .1, ZOOM_MAX: 4 };
  const body = `${lines[wiringStart]}\n${lines[wiringStart + 1]}\n${decl('installCanvasPlacementOps')}\nreturn { install: installCanvasPlacementOps, arrange };`;
  const real = new Function(...Object.keys(deps), body)(...Object.values(deps));
  real.install(viewport, layer);
  const snap = () => ({ cam: { x: state.pan.x, y: state.pan.y, zoom: state.zoom }, cards: ['A', 'B', 'C'].map(id => { const p = poses.get(id); return [id, p.x, p.y, p.width, p.height, p.zIndex]; }) });
  const key = (shift = false) => { let handled = false;
    for (const f of keyHandlers) { const ev = { metaKey: true, ctrlKey: false, altKey: false, shiftKey: shift, key: 'z', isComposing: false, keyCode: 90,
      preventDefault() { handled = true; }, stopImmediatePropagation() {}, target: doc.documentElement }; f(ev); }
    return handled; };
  const history = () => state.canvasLayoutHistory;
  // Mirrors what a finished drag/keyboard move does: history.record then geometry write (surface lines ~30394-30399).
  const manualMove = (id, dx) => { const b = poses.get(id); const before = { x: b.x, y: b.y, width: b.width, height: b.height };
    assert.ok(history().record({ label: 'move', items: [{ id, before, after: { ...before, x: before.x + dx } }] })); applyPersistentEntityGeometry(doc.getElementById(id), { x: before.x + dx }); };
  const ui = () => root.walk().filter(n => 'data-presentation-control' in n.attrs);
  const control = c => ui().find(n => n.attrs['data-presentation-control'] === c);
  const arrangeWith = async option => { await real.arrange().open('@desk', null); const r = control(option); assert.ok(r && !r.disabled, `option ${option} offered`); r.checked = true; r.fire('change');
    const apply = control('apply'); assert.ok(apply, 'apply button'); apply.fire('click'); };
  const panelUndo = async () => { await real.arrange().open('@desk', null); const b = control('undo'); const offered = !!b; if (b) b.fire('click'); real.arrange().close(); return offered; };
  const undoOffered = async () => { await real.arrange().open('@desk', null); const o = !!control('undo'); real.arrange().close(); return o; };
  return { state, poses, notices, snap, key, history, manualMove, arrangeWith, panelUndo, undoOffered, real, doc };
}
const eq = (a, b, m) => assert.deepEqual(a, b, m);

test('H1 manual move A -> Apply(pair) -> Cmd+Z -> Cmd+Z -> Shift+Cmd+Z', async () => {
  const w = world(); const s0 = w.snap();
  w.manualMove('A', 21); const s1 = w.snap();
  await w.arrangeWith('pair'); const s2 = w.snap();
  assert.notDeepEqual(s2, s1, 'pair moved cards');
  const k1 = w.key(); const t1 = w.snap(); const k2 = w.key(); const t2 = w.snap(); const k3 = w.key(true); const t3 = w.snap();
  record('H1', { s0, s1, s2, z1: { handled: k1, snap: t1 }, z2: { handled: k2, snap: t2 }, redo: { handled: k3, snap: t3 }, notices: w.notices });
  eq(t1, s1, 'first Cmd+Z reverts the arrangement (newest visible change)');
  eq(t2, s0, 'second Cmd+Z reverts the earlier manual move');
  eq(t3, s1, 'Shift+Cmd+Z re-applies the manual move');
});
test('H2 manual move AFTER Apply: Cmd+Z reverts the move first, then the arrangement; panel Undo is withheld meanwhile', async () => {
  const w = world(); const s0 = w.snap();
  await w.arrangeWith('pair'); const s1 = w.snap();
  w.manualMove('A', 13); const s2 = w.snap();
  const offered = await w.undoOffered();
  w.key(); const t1 = w.snap(); w.key(); const t2 = w.snap();
  record('H2', { s0, s1, s2, panelUndoOfferedAfterMove: offered, z1: t1, z2: t2, notices: w.notices });
  assert.equal(offered, false);
  eq(t1, s1, 'Cmd+Z #1 reverts the manual move'); eq(t2, s0, 'Cmd+Z #2 reverts the arrangement');
});
test('H3 panel Undo and Cmd+Z are one history: no double undo', async () => {
  const w = world(); const s0 = w.snap();
  w.manualMove('C', 17); const sC = w.snap();
  await w.arrangeWith('pair');
  const offered = await w.panelUndo(); const t1 = w.snap();
  const hs = w.history().size();
  w.key(); const t2 = w.snap(); w.key(); const t3 = w.snap();
  record('H3', { sC, panelUndoOffered: offered, afterPanelUndo: t1, historySize: hs, z1: t2, z2: t3, notices: w.notices });
  eq(t1, sC, 'panel Undo restored the arranged cards'); eq(hs, { undo: 1, redo: 1 }, 'the arrangement step moved to the redo side exactly once; only the manual move is left to undo');
  eq(t2, s0, 'Cmd+Z now reverts the earlier manual move, not the arrangement again'); eq(t3, s0, 'nothing more to undo');
});
test('H4 Cmd+Z of an arrangement retires the panel Undo; Redo re-applies and Cmd+Z again reverts', async () => {
  const w = world(); const s0 = w.snap();
  await w.arrangeWith('pair'); const s1 = w.snap();
  w.key(); const back = w.snap(); const offered = await w.undoOffered(); w.key(true); const again = w.snap(); w.key(); const back2 = w.snap();
  record('H4', { s0, s1, back, panelUndoOffered: offered, again, back2 });
  eq(back, s0); assert.equal(offered, false); eq(again, s1); eq(back2, s0);
});
test('H5 front (stacking only): Cmd+Z restores z, Redo restores the raise', async () => {
  const w = world(); const s0 = w.snap();
  await w.arrangeWith('front'); const s1 = w.snap();
  assert.notDeepEqual(s1, s0); w.key(); const t1 = w.snap(); w.key(true); const t2 = w.snap();
  record('H5', { s0, s1, z1: t1, redo: t2, notices: w.notices });
  eq(t1, s0); eq(t2, s1);
});
test('H6 overview (camera only): Cmd+Z restores camera; after the user pans, Cmd+Z skips instead of jumping the view', async () => {
  const w = world(); const s0 = w.snap();
  await w.arrangeWith('overview'); const s1 = w.snap(); assert.notDeepEqual(s1.cam, s0.cam);
  w.key(); const t1 = w.snap();
  w.key(true); w.state.setCanvasViewportTarget({ pan: { x: w.state.pan.x - 90, y: w.state.pan.y }, zoom: w.state.zoom }); const panned = w.snap();
  w.key(); const t2 = w.snap();
  record('H6', { s0, s1, z1: t1, panned, afterPanZ: t2, notices: w.notices });
  eq(t1, s0); eq(t2, panned); assert.ok(w.notices.some(m => /건너뛰었습니다/.test(m)), 'skip is explained with the existing notice');
});
test('H7 guard kept: user moved an arranged card after Apply and that is the newest step -> Cmd+Z reverts only that move; arrangement not undone over the user', async () => {
  const w = world(); await w.arrangeWith('pair'); const s1 = w.snap(); w.manualMove('B', 11);
  w.key(); const t1 = w.snap(); eq(t1, s1);
  // simulate the move happening WITHOUT a history entry (e.g. a host path that does not record): arrangement must go stale, not overwrite
  w.poses.set('B', { ...w.poses.get('B'), x: w.poses.get('B').x + 5 }); const moved = w.snap(); w.key();
  record('H7', { s1, afterUnrecordedMove: moved, z: w.snap(), notices: w.notices });
  eq(w.snap(), moved, 'stale arrangement step is skipped, user geometry untouched');
});
test('H3b after the panel Undo, Shift+Cmd+Z re-applies the same arrangement (one history)', async () => {
  const w = world(); await w.arrangeWith('pair'); const s1 = w.snap(); await w.panelUndo(); const s0 = w.snap(); assert.notDeepEqual(s0, s1);
  w.key(true); const t = w.snap(); record('H3b', { s0, s1, redo: t }); eq(t, s1);
});
