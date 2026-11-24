// L4 sim: a model answer that DIFFERS from the user's current choice, then Apply / Undo on the same screen.
// Synthetic host only (no Firefox, no real network, no real key). The production Board HTTP handler, Decisions client,
// budget and settings handler run for real; only the provider fetch and the chrome host (read/measure/commit) are fakes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { deflateSync, inflateSync } from 'node:zlib';
import { writeFileSync, appendFileSync } from 'node:fs';
import { createPresentationController, PRESENTATION_DECISION_PATHS as paths, PRESENTATION_OPTIONS as names }
  from '../overlay/resources/EGDeskJointPresentation.sys.mjs';
import { createBoardPresentationHttpHandler } from '../helper/egdesk-board-presentation-http.mjs';
import { createDecisionHttpHandler } from '../helper/egdesk-decision-http.mjs';
import { createDecisionBudget, DECISION_MODEL } from '../helper/egdesk-decision-client.mjs';

const OUT = process.env.L4_MATRIX_OUT;
const record = (id, data) => { if (OUT) appendFileSync(OUT, JSON.stringify({ id, ...data }) + '\n'); };
const box = (x, y, width, height) => ({ x, y, width, height });
const clean = o => structuredClone(o);
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const calm = { overlap: 'none', frame: 'inside', clip: 'inside', target: 'title', reach: 'hit', obscured: false };
const buried = { overlap: 'selected', frame: 'inside', clip: 'inside', target: 'title', reach: 'miss', obscured: true };
const i32 = n => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const crc = b => { let v = -1; for (const x of b) { v ^= x; for (let i = 0; i < 8; i++) v = v >>> 1 ^ (v & 1 ? 0xedb88320 : 0); } return (v ^ -1) >>> 0; };
const chunk = (k, d) => { const t = Buffer.from(k); return Buffer.concat([i32(d.length), t, d, i32(crc(Buffer.concat([t, d])))]); };
const W = 16, H = 10;
const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'),
  chunk('IHDR', Buffer.concat([i32(W), i32(H), Buffer.from([8, 2, 0, 0, 0])])),
  chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: H }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(W * 3, 7)]))))), chunk('IEND', Buffer.alloc(0))]).toString('base64');
// Pixel equality stand-in for the chrome's createImageBitmap compare: the server re-encodes the PNG canonically.
const rawPixels = url => { const b = Buffer.from(url.split(',')[1], 'base64'); return inflateSync(b.subarray(41, 41 + b.readUInt32BE(33))).toString('hex'); };
const KEY = 'egd-synthetic-not-a-key-0004';

// `answer`: option key the mock Decisions provider picks; null => provider returns an under-threshold (unsure) answer.
function rig({ mode = 'on', scenes = [calm, calm], cards, camera, answer = 'pair', providerGate } = {}) {
  const world = { camera: camera ?? { x: 0, y: 0, zoom: 1, minZoom: .1, maxZoom: 4 }, viewport: box(0, 0, 1320, 840),
    cards: cards ?? [{ id: 'A', rect: box(40, 60, 300, 200), z: 3 }, { id: 'B', rect: box(300, 140, 300, 200), z: 4 },
      { id: 'C', rect: box(900, 500, 240, 154), z: 2 }, { id: 'D', rect: box(1000, 60, 240, 154), z: 1 }] };
  for (const c of world.cards) Object.assign(c, { title: 'card ' + c.id, kind: '자료', visible: true, canRead: true, movable: true,
    pinned: false, maySendDescriptor: true, minWidth: 230, minHeight: 150, inFrame: true });
  const S = { savedKey: KEY, savedMode: mode, grant: true, now: 0, provider: 0, commits: [], notices: [], paths: [], decisionRev: null, answer, providerGate };
  const store = { status: 'configured', writable: true, getApiKey: () => S.savedKey, savedAt: () => 17, hint: () => null,
    save: k => { S.savedKey = k; return true; }, clear: () => { S.savedKey = null; return true; } };
  const modeStore = { get mode() { return S.savedMode; }, saved: true, persisted: true, save: m => { S.savedMode = m; return true; } };
  const labels = k => names[k];
  const board = createBoardPresentationHttpHandler({ credentials: store, getMode: () => modeStore.mode,
    budget: createDecisionBudget({ monthlyInputTokenCap: 10_000 }), fetchImpl: async (_e, init) => {
      S.provider++; S.lastProviderBody = JSON.parse(init.body);
      if (S.providerGate) await S.providerGate.promise;
      const offered = S.lastProviderBody.text?.format ? [] : [];
      void offered;
      const want = S.answer, other = want === 'keep' || want === null ? 'tidy' : 'keep';
      const first = want === null ? { v: labels('keep'), p: .52 } : { v: labels(want), p: .94 };
      const second = want === null ? { v: labels(other), p: .48 } : { v: labels(other), p: .06 };
      return Response.json({ answers: [{ name: 'board_view', type: 'choice', choice: first.v, confidence: first.p,
        probabilities: [{ value: first.v, probability: first.p }, { value: second.v, probability: second.p }] }], usage: { input_tokens: 10 } });
    } });
  const settings = createDecisionHttpHandler({ store, mode: modeStore, model: DECISION_MODEL, verifyKey: async () => ({ status: 'verified' }),
    boardPresentation: board });
  const http = async (method, path, body) => {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]),
      { url: path, method, headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json' } });
    const res = Object.assign(new EventEmitter(), { writeHead(s) { this.status = s; }, end(j) { this.body = JSON.parse(j); this.writableEnded = true; } });
    const url = new URL(path, 'http://127.0.0.1:39218');
    assert.equal(await settings(req, res, url) || await board(req, res, url), true);
    return { status: res.status, body: res.body };
  };
  const read = () => {
    const w = clean(world);
    for (const c of w.cards) c.revision = `lease:v1:z${c.z}`;
    return { ready: true, overall: true, revision: 'profile/board/layout', topZ: Math.max(...w.cards.map(c => c.z)),
      viewport: w.viewport, camera: w.camera, cards: w.cards, obstacles: [], links: [], decision: S.decision };
  };
  const api = createPresentationController({ equalPixels: async (a, b) => rawPixels(a) === rawPixels(b), now: () => S.now, read: k => k === 'desk' ? read() : null,
    measure: async (_k, ids) => ({ scene: ids.map((_, i) => scenes[i] ?? calm), photo: { image: PNG, width: W, height: H } }),
    readDecision: async () => { const r = await http('GET', '/decision/status'); const b = r.body;
      return b?.configured === true && b.mode && /^[a-f0-9]{64}$/.test(b.boardRevision) ? { available: true, mode: b.mode, revision: b.boardRevision } : null; },
    verifyDecisionAuthority: async () => S.grant,
    dismiss() {}, notice: m => S.notices.push(m),
    commit: (key, data) => { S.commits.push(clean({ key, ...data }));
      if (data.camera) Object.assign(world.camera, data.camera);
      for (const t of data.targets) { const c = world.cards.find(c => c.id === t.id); c.rect = clean(t.rect); if (Number.isFinite(t.z)) c.z = t.z; }
      return true; },
    request: async (path, body) => { S.paths.push(path); const r = await http('POST', path, body); if (process.env.L4_DEBUG) console.log(path, JSON.stringify(body).slice(0,700), '=>', JSON.stringify(r.body).slice(0,1400)); return r.body; } });
  const snap = () => clean({ camera: { x: world.camera.x, y: world.camera.y, zoom: world.camera.zoom },
    cards: world.cards.map(c => ({ id: c.id, rect: c.rect, z: c.z })) });
  const refreshDecision = async () => { const r = await http('GET', '/decision/status'); S.decision = { available: true, mode: r.body.mode, revision: r.body.boardRevision }; };
  const flip = async (m) => { await http('POST', '/decision/mode', { mode: m }); };
  return { api, world, S, snap, http, refreshDecision, flip, board };
}
// open the Desk review with exactly the cards in `pick`, and the user's own manual choice `mine`
async function start(r, pick, mine) {
  await r.refreshDecision();
  assert.equal(r.api.open('desk'), true);
  for (const id of ['A', 'B', 'C', 'D']) if (!pick.includes(id)) r.api.select(id, false);
  for (const id of pick) r.api.select(id, true);
  r.api.focus(pick[0]);
  r.api.choose(mine);
  assert.equal(r.api.view().choice, mine, `user's own choice ${mine} is selectable`);
}
async function ask(r, cue = '지금 하던 일을 이어가기 쉽게 정돈해줘') {
  await r.api.prepare(cue);
  assert.equal(r.api.view().phase, 'review', r.api.view().message);
  await r.api.confirm();
}
const diff = (a, b) => {
  const out = [];
  for (const c of b.cards) { const o = a.cards.find(x => x.id === c.id); if (JSON.stringify(o) !== JSON.stringify(c)) out.push(c.id); }
  if (JSON.stringify(a.camera) !== JSON.stringify(b.camera)) out.push('camera');
  return out;
};
const sameArr = (x, y) => JSON.stringify(x) === JSON.stringify(y);

test('J1 keep -> pair: model differs from the user choice; preview, apply, undo restore exactly', async t => {
  const r = rig({ answer: 'pair' }); t.after(() => r.api.close());
  await start(r, ['A', 'B'], 'keep'); const initial = r.snap();
  assert.ok(r.api.view().options.includes('pair'), 'offered: ' + r.api.view().options);
  await ask(r);
  assert.equal(r.S.provider, 1); const v = r.api.view();
  assert.equal(v.choice, 'pair'); assert.equal(r.S.commits.length, 0); assert.deepEqual(r.snap(), initial, 'preview wrote nothing');
  assert.equal(await r.api.apply(), true);
  const applied = r.snap(); const changed = diff(initial, applied);
  assert.deepEqual(changed, ['A', 'B'], 'only the two selected cards moved'); assert.deepEqual(applied.camera, initial.camera);
  assert.deepEqual(applied.cards.map(c => c.z), initial.cards.map(c => c.z));
  record('J1', { before: initial.cards.slice(0, 2), after: applied.cards.slice(0, 2), changed, notices: r.S.notices });
  r.api.open('desk'); assert.equal(r.api.view().undo, true); assert.equal(r.api.undo(), true);
  assert.deepEqual(r.snap(), initial);
  r.api.open('desk'); assert.equal(r.api.view().undo, false);
});

test('J2 pair -> front: only z of the focus card changes, undo restores z', async t => {
  const r = rig({ answer: 'front', scenes: [buried, calm] }); t.after(() => r.api.close());
  await start(r, ['A', 'B'], 'pair'); const initial = r.snap();
  assert.ok(r.api.view().options.includes('front'), 'front offered: ' + r.api.view().options);
  await ask(r);
  assert.equal(r.api.view().choice, 'front'); assert.deepEqual(r.snap(), initial);
  assert.equal(await r.api.apply(), true);
  const applied = r.snap(); const changed = diff(initial, applied);
  assert.deepEqual(changed, ['A']); assert.equal(applied.cards[0].z, 5);
  assert.deepEqual(applied.cards[0].rect, initial.cards[0].rect);
  record('J2', { before: initial.cards[0], after: applied.cards[0], changed });
  r.api.open('desk'); assert.equal(r.api.undo(), true); assert.deepEqual(r.snap(), initial);
});

test('J3 pair -> tidy: targets limited to selected, others untouched, undo exact', async t => {
  const r = rig({ answer: 'tidy' }); t.after(() => r.api.close());
  await start(r, ['A', 'B'], 'pair'); const initial = r.snap();
  assert.ok(r.api.view().options.includes('tidy'), 'tidy offered: ' + r.api.view().options);
  await ask(r);
  assert.equal(r.api.view().choice, 'tidy'); assert.deepEqual(r.snap(), initial);
  assert.equal(await r.api.apply(), true);
  const applied = r.snap(); const changed = diff(initial, applied);
  assert.ok(changed.every(id => ['A', 'B'].includes(id)) && changed.length, 'changed: ' + changed);
  assert.deepEqual(applied.cards.slice(2), initial.cards.slice(2)); assert.deepEqual(applied.camera, initial.camera);
  record('J3', { before: initial.cards.slice(0, 2), after: applied.cards.slice(0, 2), changed });
  r.api.open('desk'); assert.equal(r.api.undo(), true); assert.deepEqual(r.snap(), initial);
});

test('J4 overview: camera only, undo restores camera', async t => {
  const r = rig({ answer: 'overview' }); t.after(() => r.api.close());
  await start(r, ['A', 'B'], 'keep'); const initial = r.snap();
  await ask(r); assert.equal(r.api.view().choice, 'overview');
  assert.equal(await r.api.apply(), true);
  const applied = r.snap();
  assert.deepEqual(diff(initial, applied), ['camera']); assert.deepEqual(r.S.commits[0].targets, []);
  record('J4', { cameraBefore: initial.camera, cameraAfter: applied.camera, changed: diff(initial, applied) });
  r.api.open('desk'); assert.equal(r.api.undo(), true); assert.deepEqual(r.snap(), initial);
});

test('J5 rejection: unsure / keep answer keeps the manual selection, zero commits', async t => {
  for (const answer of [null, 'keep']) {
    const r = rig({ answer }); await start(r, ['A', 'B'], 'pair'); const initial = r.snap();
    await ask(r);
    const v = r.api.view();
    record('J5-' + answer, { choice: v.choice, message: v.message });
    assert.equal(v.choice, 'pair', 'manual choice stays'); assert.equal(r.S.commits.length, 0); assert.deepEqual(r.snap(), initial);
    r.api.close();
  }
});

test('J6a photo permission revoked after review, before send: zero run POST and zero provider calls', async t => {
  const r = rig({ answer: 'pair' }); t.after(() => r.api.close());
  await start(r, ['A', 'B'], 'keep');
  await r.api.prepare('정돈'); assert.equal(r.api.view().phase, 'review');
  r.S.grant = false; await r.api.confirm();
  record('J6a', { paths: r.S.paths, provider: r.S.provider, commits: r.S.commits.length, message: r.api.view()?.message });
  assert.deepEqual(r.S.paths.filter(p => p === paths.run), []); assert.equal(r.S.provider, 0); assert.equal(r.S.commits.length, 0);
  assert.equal(r.api.view().choice, 'keep'); assert.equal(await r.api.apply(), true /* keep: close only */);
  assert.equal(r.S.commits.length, 0);
});

test('J6b revoked while the provider call is in flight: late answer never previews or applies', async t => {
  const gate = defer(); const r = rig({ answer: 'pair', providerGate: gate }); t.after(() => r.api.close());
  await start(r, ['A', 'B'], 'keep'); const initial = r.snap();
  await r.api.prepare('정돈'); const pending = r.api.confirm();
  for (let i = 0; i < 200 && !r.S.provider; i++) await new Promise(res => setTimeout(res, 5));
  r.S.grant = false; gate.resolve(); await pending;
  record('J6b', { provider: r.S.provider, choice: r.api.view()?.choice, message: r.api.view()?.message });
  assert.equal(r.api.view().choice, 'keep'); assert.equal(r.S.commits.length, 0); assert.deepEqual(r.snap(), initial);
});

test('J7 revoked / mode flipped between preview and Apply: refused, reverts to the user choice', async t => {
  for (const how of ['grant', 'mode-off-on', 'mode-off']) {
    const r = rig({ answer: 'pair' });
    await start(r, ['A', 'B'], 'keep'); const initial = r.snap();
    await ask(r); assert.equal(r.api.view().choice, 'pair');
    if (how === 'grant') r.S.grant = false;
    else { await r.flip('off'); if (how === 'mode-off-on') await r.flip('on'); }
    const ok = await r.api.apply();
    record('J7-' + how, { ok, commits: r.S.commits.length, choice: r.api.view()?.choice ?? 'closed', message: r.api.view()?.message });
    assert.equal(ok, false); assert.equal(r.S.commits.length, 0); assert.deepEqual(r.snap(), initial);
    r.api.close();
  }
});

// ---- Undo correctness after the user acts on the same screen ----
async function applied(answer, pick, mine, extra = {}) {
  const r = rig({ answer, ...extra }); await start(r, pick, mine); const initial = r.snap();
  await ask(r); assert.equal(await r.api.apply(), true); return { r, initial, after: r.snap() };
}
test('J8 manual move of an arranged card after Apply: Undo is withheld (never overwrites the user)', async t => {
  const { r, after } = await applied('pair', ['A', 'B'], 'keep'); t.after(() => r.api.close());
  r.world.cards[0].rect = { ...r.world.cards[0].rect, x: r.world.cards[0].rect.x + 9 };
  r.api.open('desk'); const v = r.api.view();
  record('J8', { undoOffered: v.undo, undoResult: r.api.undo(), commits: r.S.commits.length });
  assert.equal(v.undo, false); assert.equal(r.S.commits.length, 1);
});
test('J9 an UNRELATED card moved after Apply: arrangement Undo still restores the arranged cards only', async t => {
  const { r, initial } = await applied('pair', ['A', 'B'], 'keep'); t.after(() => r.api.close());
  r.world.cards[2].rect = { ...r.world.cards[2].rect, x: r.world.cards[2].rect.x + 31 };
  const moved = clean(r.world.cards[2].rect);
  r.api.open('desk'); const offered = r.api.view().undo; const ok = r.api.undo();
  record('J9', { undoOffered: offered, undoResult: ok, commits: r.S.commits.length });
  assert.equal(offered, true); assert.equal(ok, true);
  assert.deepEqual(r.world.cards.slice(0, 2).map(c => c.rect), initial.cards.slice(0, 2).map(c => c.rect));
  assert.deepEqual(r.world.cards[2].rect, moved, "the user's own later move of C is kept");
});
test('J10 camera pan/zoom after a card Apply: Undo still restores card poses and leaves the user camera alone', async t => {
  const { r, initial } = await applied('pair', ['A', 'B'], 'keep'); t.after(() => r.api.close());
  r.world.camera.x -= 120; r.world.camera.y -= 40; const cam = clean(r.world.camera);
  r.api.open('desk'); const offered = r.api.view().undo; const ok = r.api.undo();
  record('J10', { undoOffered: offered, undoResult: ok, commits: r.S.commits.length });
  assert.equal(offered, true); assert.equal(ok, true);
  assert.deepEqual(r.world.cards.slice(0, 2).map(c => c.rect), initial.cards.slice(0, 2).map(c => c.rect));
  assert.deepEqual(r.world.camera, cam);
});
test('J11 camera-only Apply then camera moved by the user: Undo withheld (would jump the view)', async t => {
  const { r } = await applied('overview', ['A', 'B'], 'keep'); t.after(() => r.api.close());
  r.world.camera.x -= 50; r.api.open('desk');
  record('J11', { undoOffered: r.api.view().undo });
  assert.equal(r.api.view().undo, false);
});

// ---- result freshness ----
test('J12 the Apply window for a model preview starts when the preview appears, not when the review was prepared', async t => {
  const r = rig({ answer: 'pair' }); t.after(() => r.api.close());
  await start(r, ['A', 'B'], 'keep'); const initial = r.snap();
  await r.api.prepare('정돈');                     // t = 0, ticket TTL 60 s
  r.S.now = 50_000;                                // user spends 50 s reading the outbound packet
  await r.api.confirm(); assert.equal(r.api.view().choice, 'pair');
  r.S.now = 61_000;                                // 11 s after the preview appeared (61 s after prepare)
  const ok = await r.api.apply();
  record('J12', { ok, commits: r.S.commits.length, choice: r.api.view()?.choice, message: r.api.view()?.message });
  assert.equal(ok, true); assert.notDeepEqual(r.snap(), initial);
});
test('J13 model answers the SAME option the user already chose: the screen says so', async t => {
  const r = rig({ answer: 'pair' }); t.after(() => r.api.close());
  await start(r, ['A', 'B'], 'pair'); await ask(r);
  const v = r.api.view(); record('J13', { choice: v.choice, message: v.message });
  assert.match(v.message, /같은|이미/);
});
test('J14 successful Apply tells the user where Undo lives', async t => {
  const { r } = await applied('pair', ['A', 'B'], 'keep'); t.after(() => r.api.close());
  record('J14', { notices: r.S.notices });
  assert.ok(r.S.notices.some(m => /되돌/.test(m)));
});
