// L4 cycle 4: ONE cross-lane Board journey on mounted code.
//   photo arrangement (model answer differs from the user's pick) -> Apply -> a member's one-off question with reply screening in
//   advisory then on -> mode switched while an arrangement request is pending -> spend_limit_reached on the next arrangement ->
//   Cmd+Z / Shift+Cmd+Z -> reload with the persisted personal pose.
// Mounted (real source): surface installCanvasPlacementOps + arrange wiring + markAgendaDirty, WorkbenchArrange (one seam: the
// photo capture, which has its own tests, is replaced by a canonical PNG), JointPresentation panel + controller, JointBoardView
// pose/save, the production Board presentation HTTP handler, Decisions settings handler, Decisions client + ONE shared budget,
// the Board ask service over a temp SQLite desk with the real review flow, and the real calibration log. Fakes: DOM nodes, the
// pref store, the provider fetch (synthetic key egd-synthetic-not-a-key-0004, no network).
import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync, rmSync, chmodSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as CanvasLayout from '../overlay/resources/EGDeskCanvasLayout.sys.mjs';
import { jointSnapshot } from '../overlay/resources/EGDeskJointBoardClient.sys.mjs';
import { createReviewFlow } from '../overlay/resources/EGDeskReviewHandoff.sys.mjs';
import { createBoardPresentationHttpHandler } from '../helper/egdesk-board-presentation-http.mjs';
import { createDecisionHttpHandler } from '../helper/egdesk-decision-http.mjs';
import { createDecisionBudget, createDecisionClient, estimateInputTokens, DECISION_MODEL } from '../helper/egdesk-decision-client.mjs';
import { openCalibrationLog } from '../helper/egdesk-decision-calibration-log.mjs';
import { validateBoardVisual } from '../helper/egdesk-board-visual-packet.mjs';
import { createBoardAgentAskService } from '../helper/egdesk-board-agent-ask.mjs';
import { selectBoardAgentContext } from '../helper/egdesk-board-agent-context.mjs';
import { createBoardAgentDraftTransport } from '../helper/egdesk-board-agent-draft.mjs';
import { openDeskStore } from '../helper/egdesk-desk-store.mjs';
import { createPrivateQaTempDirectory } from './egdesk-qa-platform.mjs';

const OUT = process.env.L4_MATRIX_OUT;
const record = (id, data) => { if (OUT) appendFileSync(OUT, JSON.stringify({ id, ...data }) + '\n'); };
const surface = readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const viewSrc = readFileSync(new URL('../overlay/resources/EGDeskJointBoardView.sys.mjs', import.meta.url), 'utf8');
const sl = surface.split('\n');
const ws = sl.findIndex(l => l.startsWith('  let jointDesk = null,arrangeUI=null;'));
assert.ok(ws >= 0 && sl[ws + 1].startsWith('  const arrange=()=>arrangeUI??='));
const decl = (src, name) => { const s = src.indexOf(`  function ${name}(`); assert.ok(s >= 0, name); return src.slice(s, src.indexOf('\n  }', s) + 4); };
const KEY = 'egd-synthetic-not-a-key-0004';
const pair = '선택한 두 장 나란히 비교', keep = '현재 배치 유지';
const i32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const crc = b => { let v = -1; for (const x of b) { v ^= x; for (let i = 0; i < 8; i++) v = v >>> 1 ^ (v & 1 ? 0xedb88320 : 0); } return (v ^ -1) >>> 0; };
const chunk = (k, d) => { const t = Buffer.from(k); return Buffer.concat([i32(d.length), t, d, i32(crc(Buffer.concat([t, d])))]); };
const sha = text => createHash('sha256').update(text).digest('hex');

// ---- WorkbenchArrange with exactly one test seam (photo capture) ----
async function seamedArrange() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'egdesk-seam-'));
  let src = readFileSync(new URL('../overlay/resources/EGDeskWorkbenchArrange.sys.mjs', import.meta.url), 'utf8');
  src = src.replace(/from '\.\/(EGDesk[A-Za-z]+\.sys\.mjs)'/g, (_m, f) => `from '${new URL('../overlay/resources/' + f, import.meta.url).href}'`);
  const needle = 'async function measure(key,ids,{photo=false}={}){';
  assert.equal(src.split(needle).length, 2, 'measure seam anchor');
  src = src.replace(needle, needle + 'if(globalThis.__egdMeasureSeam)return globalThis.__egdMeasureSeam(key,ids,{photo});');
  const file = path.join(dir, 'WorkbenchArrange.seam.mjs'); writeFileSync(file, src);
  const mod = await import(pathToFileURL(file).href); rmSync(dir, { recursive: true, force: true }); return mod;
}

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
function world({ WorkbenchArrange, http, grant }) {
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
  return { state, poses, notices, httpLog, fetches, JD, doc, control, ui, seen, reloaded, key, arrangeWith, panelUndo, manualMove, persistedMatchesScreen, prefWrites: () => prefWrites, sessionSaves: () => sessionSaves, pref: () => prefText, real };
}

// ---- shared host rig: ONE credential store, ONE mode, ONE budget, ONE calibration log for every Board feature ----
const E = ['Friday visitors park behind the gym.', 'Meet in the atrium on Friday.', 'Catering invoice totals seventy credits.'];
const QUESTION = 'Where do visitors park on Friday?';
const BOARD = 'board-crosslane-sim', PROFILE = 'profile-crosslane-sim';
const profile = { lifecycle: 'active', activeRevision: 1, active: { revision: 1, hash: 'a'.repeat(64), body: { name: 'Sim Agent', model: null } } };
const ans = (a, b, choice) => ({ name: 'board_view', type: 'choice', choice, confidence: a,
  probabilities: [{ value: choice, probability: a }, { value: choice === pair ? keep : pair, probability: b }] });

async function rig(t, { mode = 'on' } = {}) {
  const root = createPrivateQaTempDirectory('egdesk-crosslane-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const S = { key: KEY, mode, grant: true };
  const store = { status: 'configured', writable: true, getApiKey: () => S.key, savedAt: () => 17, hint: () => null, save: k => { S.key = k; return true; }, clear: () => { S.key = null; return true; } };
  const modeStore = { get mode() { return S.mode; }, saved: true, persisted: true, save: m => { S.mode = m; return true; } };
  const budget = createDecisionBudget({ monthlyInputTokenCap: 100000 });
  const calibration = openCalibrationLog({ dataDir: path.join(root, 'settings'), log() {} });
  // provider: scripted answers for the arrangement question; fixed predicate answers for the reply screening
  const P = { calls: [], script: [], hung: null };
  const provider = async (_url, init) => {
    const body = JSON.parse(init.body), name = body.questions[0].name;
    P.calls.push({ name, wire: init.body });
    if (name === 'board_view') {
      const step = P.script.shift();
      assert.ok(step, 'a scripted provider answer exists for this arrangement request');
      if (step.hang) return new Promise((_, reject) => { P.hung?.(); init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }); });
      if (step.status) return Response.json({ error: { code: step.code, type: step.code } }, { status: step.status });
      return Response.json({ answers: [ans(step.a, step.b, step.choice)], usage: { input_tokens: 10 } });
    }
    return Response.json({ model: DECISION_MODEL, answers: body.questions.map((q, i) => ({ name: q.name, type: 'predicate', probability: [0.1, 0.98, 0.02][i] })), usage: { input_tokens: 7 } });
  };
  const board = createBoardPresentationHttpHandler({ credentials: store, getMode: () => modeStore.mode, budget, fetchImpl: provider, calibrationLog: calibration });
  const settings = createDecisionHttpHandler({ store, mode: modeStore, model: DECISION_MODEL, budget, verifyKey: async () => ({ status: 'verified' }), boardPresentation: board });
  const http = async (method, p, body) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { url: p, method,
      headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' } });
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead(s) { this.status = s; }, end(j) { this.body = JSON.parse(j); this.writableEnded = true; } });
    const url = new URL(p, 'http://127.0.0.1:39218');
    assert.equal(await settings(req, res, url) || await board(req, res, url), true, p);
    return { status: res.status, body: res.body };
  };
  // Board ask service (L1) with the SAME client budget and the SAME calibration log, as the bridge wires them
  const desk = openDeskStore({ dataDir: path.join(root, 'desk'), ownerScope: 'crosslane-sim' });
  desk.saveBoard(BOARD, { body: { version: 1, agenda: { id: BOARD, title: 'Sim Board' }, cards: [], shapes: [] }, expectedRevision: null });
  const askClient = createDecisionClient({ getApiKey: () => S.key, budget, fetchImpl: provider });
  // No per-request screening choice any more: Decisions screens the approved excerpts only in a draft run (the run that already
  // sends them to the drafting model), so the member's question is answered with a draft here. The drafting provider is a mock.
  const draftGot = [];
  const draft = createBoardAgentDraftTransport({ readConfig: () => ({ apiKey: 'egd-synthetic-draft-not-a-key-0002', model: 'synthetic-responses-model' }),
    fetchImpl: async (_url, init) => {
      draftGot.push(JSON.parse(JSON.parse(init.body).input[0].content[0].text).excerpts);
      return Response.json({ object: 'response', status: 'completed', model: 'synthetic-responses-model', output: [{ type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: 'Synthetic drafted reply.' }] }] });
    } });
  const service = createBoardAgentAskService({ desk, profiles: { get: id => id === PROFILE ? profile : null }, selectContext: selectBoardAgentContext, calibrationLog: calibration,
    decisionStatus: () => S.mode === 'off' ? null : ({ mode: S.mode, model: DECISION_MODEL, bindingId: 'sim-binding', client: askClient }), draft });
  t.after(() => { service.close(); desk.close(); });
  let version = service.policy({ boardId: BOARD, action: 'save', expectedVersion: null, profileId: PROFILE, excerpts: E, publicInstructions: '' }).policy.version;
  async function ask() {
    const issued = service.policy({ boardId: BOARD, action: 'issue', expectedVersion: version }); version = issued.policy.version;
    const request = { kind: 'request', requestId: '8878a7f3-df6b-4383-af12-6ae38ad4fe2e', requestDigest: sha(String(Math.random())), question: QUESTION, recipient: 'Member', excerpt: '', expectedReply: 'short', askCode: issued.askCode };
    const prepared = service.prepare({ boardId: BOARD, request, mode: 'draft' });
    const result = await service.run({ ticket: prepared.ticket, confirm: true });
    const binding = Object.freeze({}), b = { id: BOARD, title: 'Sim Board' };
    const flow = createReviewFlow({ getContext: () => binding, isContextCurrent: v => v === binding, getBoard: () => b, isBoardCurrent: () => true,
      store: { check() {}, issue() {} }, pickFile: async () => ({ bytes: new Uint8Array([1]) }), request: async () => ({ status: 200, body: { locked: false, encrypted: true, review: request } }) });
    flow.openFile(); await flow.chooseFile();
    assert.equal(flow.beginAgentReply(flow.view().review, b, result), true);
    return { prepared, result, note: flow.view().answerSource, used: draftGot.at(-1)?.length ?? 0 };
  }
  return { S, P, store, budget, calibration, http, desk, ask, board, settings, root };
}
const until = async (cond, label) => { for (let i = 0; i < 600; i++) { const v = cond(); if (v) return v; await new Promise(r => setTimeout(r, 5)); } throw new Error('timed out waiting for ' + label); };
const total = b => b.snapshot().inputTokens + (b.snapshot().estimatedInputTokens || 0);

test('Board journey across lanes: arrangement -> apply -> ask (advisory, on) -> mode flip while pending -> spend limit -> Cmd+Z -> reload', async t => {
  const Arrange = await seamedArrange();
  const r = await rig(t, { mode: 'on' });
  const W = world({ WorkbenchArrange: Arrange, http: r.http, grant: () => r.S.grant });
  const params = { composition: { density: 'sparse', readability: 'comfortable', alignment: 'scattered', flow: 'unlinked', focus: 'competing', distribution: 'balanced', openSpace: 'room', movement: 'moderate' } };
  const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', Buffer.concat([i32(16), i32(10), Buffer.from([8, 2, 0, 0, 0])])),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 10 }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(48, 7)]))))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
  const canon = validateBoardVisual({ image: PNG, width: 16, height: 10, candidates: [], allowPair: true, ...params }).image;
  assert.equal(validateBoardVisual({ image: canon, width: 16, height: 10, candidates: [], allowPair: true, ...params }).image, canon, 'canonical PNG is a fixed point');
  const calm = { overlap: 'none', frame: 'inside', clip: 'inside', target: 'title', reach: 'hit', obscured: false };
  globalThis.__egdMeasureSeam = async (_k, ids) => ({ scene: ids.map(() => calm), photo: { image: canon, width: 16, height: 10 } });
  t.after(() => { delete globalThis.__egdMeasureSeam; });

  await r.http('GET', '/decision/status'); // chrome reads the settings epoch as it does on open
  const ledger0 = JSON.stringify(r.desk.boardRevisions(BOARD)), generation0 = JSON.stringify(r.desk.current().generation);
  const statusText = () => W.doc.documentElement.walk().find(n => n.attrs['data-testid'] === 'joint-presentation-status')?.textContent ?? '';
  const click = id => { const n = W.control(id); assert.ok(n, 'control ' + id); n.fire('click'); };
  async function recommend({ mine = 'keep', script, hold = false }) {
    r.P.script.push(script);
    await W.real.arrange().open('proj1', null);
    const radio = W.control(mine); assert.ok(radio && !radio.disabled, mine + ' offered'); radio.checked = true; radio.fire('change');
    click('prepare'); await until(() => W.control('confirm'), 'review');
    const before = r.P.calls.length; click('confirm');
    if (hold) { await until(() => r.P.calls.length > before, 'provider call started'); return { pending: true }; }
    await until(() => W.control('cue') && !W.control('decision-cancel'), 'response settled');
    return { status: statusText(), choice: ['keep', 'overview', 'focus', 'pair', 'front', 'tidy', 'handoff', 'workbench'].find(k => W.control(k)?.checked) };
  }
  const apply = async () => { click('apply'); await until(() => !W.control('apply'), 'panel closed after apply'); };
  const s0 = W.seen();

  // 1. photo arrangement: the model answers pair although the user's own pick is keep
  const a1 = await recommend({ mine: 'keep', script: { a: .94, b: .06, choice: pair } });
  record('step1-preview', { ...a1, providerCalls: r.P.calls.length, budget: r.budget.snapshot() });
  assert.equal(a1.choice, 'pair'); assert.equal(r.P.calls.length, 1, 'one paid request for the one explicit send'); assert.deepEqual(W.seen(), s0, 'preview wrote nothing');
  await apply(); const s1 = W.seen();
  assert.notDeepEqual(s1.cards, s0.cards); assert.ok(W.persistedMatchesScreen(), 'saved personal pose == applied layout');
  assert.equal(total(r.budget), 10);
  assert.equal(JSON.stringify(r.desk.boardRevisions(BOARD)), ledger0, 'a personal arrangement (preview + apply) writes no shared Board revision');
  const histAfterApply = W.state.canvasLayoutHistory.size();
  assert.deepEqual(histAfterApply, { undo: 1, redo: 0 });

  // 2. a member's one-off question, reply screening advisory and then on (L1) on the SAME budget and log
  r.S.mode = 'advisory';
  const adv = await r.ask();
  r.S.mode = 'on';
  const on = await r.ask();
  record('step2-ask', { advisory: { screening: adv.result.screening, note: adv.note, used: adv.used }, on: { screening: on.result.screening, note: on.note, used: on.used },
    providerCalls: r.P.calls.map(c => c.name), budget: r.budget.snapshot() });
  assert.equal(r.P.calls.filter(c => c.name !== 'board_view').length, 2, 'one paid screening request per explicit ask');
  assert.equal(adv.result.screening, 'advisory'); assert.match(adv.note, /기록만.*반영하지 않고/);
  assert.equal(on.result.screening, 'decision'); assert.match(on.note, /Decisions API를 사용했습니다/);
  assert.equal(total(r.budget), 10 + 7 + 7, 'each request is metered once, on the shared budget');
  const ledgerAfterAsk = JSON.stringify(r.desk.boardRevisions(BOARD)); // owner-side ask codes/policy are explicit Board actions, not personal ones
  assert.deepEqual(W.seen(), s1, 'asking never moves the personal layout');
  assert.deepEqual(W.state.canvasLayoutHistory.size(), histAfterApply, 'history intact');

  // 3. mode switched while an arrangement request is pending
  const meas0 = r.budget.snapshot().inputTokens;
  await W.real.arrange().close?.();
  const held = await recommend({ mine: 'keep', script: { hang: true }, hold: true });
  assert.ok(held.pending);
  const wire = r.P.calls.at(-1).wire;
  await r.http('POST', '/decision/mode', { mode: 'advisory' });
  await until(() => W.control('cue') && !W.control('decision-cancel') || /결정 모델 설정/.test(statusText()), 'pending request settled after the mode change');
  const snap3 = r.budget.snapshot();
  record('step3-mode-flip', { status: statusText(), budget: snap3, estimateOfWire: estimateInputTokens(wire), providerCalls: r.P.calls.length });
  assert.equal(r.P.calls.filter(c => c.name === 'board_view').length, 2, 'one paid request for this explicit send');
  assert.equal(snap3.inputTokens, meas0, 'no usage was reported for the cancelled request');
  assert.equal(snap3.unmeteredRequests, 1); assert.equal(snap3.estimatedInputTokens, estimateInputTokens(wire), 'sent-then-cancelled estimate is exactly the wire estimate');
  assert.match(statusText(), /결정 모델 설정이나 자료 권한이 바뀌었습니다/);
  assert.deepEqual(W.seen(), s1, 'the cancelled recommendation changed nothing'); assert.deepEqual(W.state.canvasLayoutHistory.size(), histAfterApply);
  W.real.arrange().close();

  // 4. back to on; the next arrangement hits the provider's spend limit
  await r.http('POST', '/decision/mode', { mode: 'on' });
  const callsBefore = r.P.calls.length, budgetBefore = r.budget.snapshot();
  const a4 = await recommend({ mine: 'keep', script: { status: 429, code: 'organization_spend_limit_exceeded' } });
  record('step4-spend-limit', { ...a4, providerCalls: r.P.calls.length - callsBefore, budget: r.budget.snapshot(), calibration: r.calibration.entries().map(e => [e.feature, e.mode, e.fallback ?? null, e.judgments[0]?.would ?? null]) });
  assert.equal(r.P.calls.length - callsBefore, 1, 'one paid request, no automatic retry');
  assert.deepEqual(r.budget.snapshot(), budgetBefore, 'a rejected request adds nothing to the tally');
  assert.deepEqual(W.seen(), s1); assert.deepEqual(W.state.canvasLayoutHistory.size(), histAfterApply);
  assert.match(a4.status, /한도/, 'the user is told it was the spend limit (same wording family as the DM chooser)');
  W.real.arrange().close();

  // 4b. the owner's local monthly cap is reached: nothing is sent, and the screen says so (same sentence as the DM chooser)
  r.budget.setCap(1); const callsCap = r.P.calls.length;
  await W.real.arrange().open('proj1', null); click('prepare'); await until(() => W.control('cue') && !W.control('decision-cancel') && /./.test(statusText()), 'prepare refused');
  record('step4b-local-cap', { status: statusText(), providerCalls: r.P.calls.length - callsCap });
  assert.equal(r.P.calls.length, callsCap, 'no request leaves the machine'); assert.match(statusText(), /이번 달 EG-Desk 결정 모델 사용 한도에 도달해 요청을 보내지 않았습니다/);
  W.real.arrange().close(); r.budget.setCap(100000);

  // 5. Cmd+Z sequence
  W.key(); const z1 = W.seen(); const pz1 = W.persistedMatchesScreen();
  W.key(); const z2 = W.seen();
  W.key(true); const redo = W.seen(); const predo = W.persistedMatchesScreen();
  record('step5-keys', { z1: z1.cards, undoPersisted: pz1, z2: z2.cards, redo: redo.cards, redoPersisted: predo, history: W.state.canvasLayoutHistory.size() });
  assert.deepEqual(z1.cards, s0.cards, 'Cmd+Z reverts the arrangement, not an Ask or a failed request'); assert.ok(pz1);
  assert.deepEqual(z2.cards, s0.cards, 'a second Cmd+Z has nothing else to revert'); assert.deepEqual(redo.cards, s1.cards); assert.ok(predo);

  // 6. reload: the persisted personal pose is what the user last saw; shared ledger and Desk save untouched; no network from the chrome
  const reloaded = W.reloaded(); const lastSeen = W.seen().cards.filter(c => c[0] !== 'C');
  record('step6-reload', { reloaded, lastSeen, fetches: W.fetches.length, prefWrites: W.prefWrites() });
  assert.deepEqual(reloaded, lastSeen); assert.equal(W.fetches.length, 0);
  assert.equal(JSON.stringify(r.desk.boardRevisions(BOARD)), ledgerAfterAsk, 'cancelled/failed arrangements, Cmd+Z/redo and reload write no shared Board revision');
  assert.equal(JSON.stringify(r.desk.current().generation), generation0);
  assert.deepEqual(W.httpLog.filter(([m, p]) => !(m === 'GET' && p === '/decision/status') && !p.startsWith('/decision/board-presentation')), [], 'the chrome only talks to the Decisions routes');

  // 7. calibration log: one content-free row per answered request, features separable, no text/ids/geometry/image
  const rows = r.calibration.entries();
  record('step7-calibration', { rows: rows.map(e => ({ feature: e.feature, mode: e.mode, fallback: e.fallback ?? null, would: e.judgments[0]?.would ?? null, attached: e.attached ?? null, outcome: e.outcome ?? null })) });
  const raw = JSON.stringify(rows);
  for (const bad of ['Friday', 'gym', 'PRIVATE', KEY, 'data:image', 'item-A', 'vA', QUESTION, pair, keep]) assert.ok(!raw.includes(bad), 'no content in the calibration log: ' + bad);
  assert.deepEqual(rows.filter(e => e.feature === 'board_arrangement').map(e => [e.mode, e.fallback ?? null, e.judgments[0]?.would ?? null]),
    [['on', null, 'accept'], ['on', 'spend_limit_reached', null]]);
});
