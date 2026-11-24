// Presence with its two consumers, real modules from three lanes on one snapshot:
//   L1 the joint Board presence feed (service hub + client module, loopback), the Desk presence and the bridge mirror
//   L4 the placement runtime (EGDeskWorkPlacement: single-user provider, scene, options, hard rules) and its bridge DTO check
//   L3 the heartbeat's audience rule (audienceFacts, and the same rule inside the real chat runtime over a mock engine)
// Synthetic: the three people, their Desks (offset, view, cards), the clock, the Decision model and the engine. Loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { createJointStore } from './egdesk-joint-board-store.mjs';
import { jointHttp } from './egdesk-joint-board-server.mjs';
import { createJointPresence as createHub, PRESENCE_LIMITS } from './egdesk-joint-presence.mjs';
import { createPresenceMirror, createPresenceMirrorHttpHandler, normalizePresenceRows, PRESENCE_MIRROR } from './egdesk-presence-mirror.mjs';
import { audienceFacts } from './egdesk-conversation-flow.mjs';
import { world as heartbeatWorld } from './egdesk-heartbeat-flow.fixture.mjs';
import { normalizePlacementDto } from './egdesk-work-placement.mjs';
import { createJointClient } from '../overlay/resources/EGDeskJointBoardClient.sys.mjs';
import * as JP from '../overlay/resources/EGDeskJointPresence.sys.mjs';
import * as WP from '../overlay/resources/EGDeskWorkPlacement.sys.mjs';

const KEYS = ['member', 'self', 'active', 'viewport', 'focusCard', 'lastInputAgeMs'];
const r = (x, y, width, height) => ({ x, y, width, height });
const hits = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ---------- the world: one loopback joint Board service, three seated people ----------
async function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-presence-int-'));
  const file = path.join(dir, 'joint.sqlite');
  const clock = { now: 1_800_000_000_000 };
  const store = createJointStore(file, { now: () => clock.now });
  const keys = {};
  for (const p of ['a', 'b', 'c']) keys[p] = store.issueAccount(p, 'synthetic ' + p);
  const act = (p, action, o = {}) => store.mutate(p, { action, ...o, request: randomUUID() });
  const board = act('b', 'accept', { invite: act('a', 'propose', { to: 'b', title: 'synthetic board' }).sent[0].id }).boards[0].id;
  act('a', 'inviteBoard', { board, to: 'c' }); act('c', 'accept', { invite: store.view('c').invites[0].id });
  const hub = createHub({ access: store.presenceAccess, now: () => clock.now });
  const server = await new Promise((resolve) => { const h = http.createServer(jointHttp(store, { presence: hub })); h.listen(0, '127.0.0.1', () => resolve(h)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  // One person: the real joint client and presence module. The own row comes from L4's real single-user provider over a synthetic Desk.
  async function person(who, { offset, view }) {
    const desk = { offset, view, focus: null, inputAt: clock.now };
    const single = WP.createSingleUserPresence({ viewport: () => ({ ...desk.view }), focusCard: () => desk.focus, lastInputAt: () => desk.inputAt, now: () => clock.now });
    const client = createJointClient({ request: (url, init) => fetch(url, init), timeoutSignal: () => AbortSignal.timeout(7000), uuid: randomUUID, apply() {}, unavailable() {} });
    await client.connect(origin, keys[who]);
    const joint = JP.createJointPresence({ send: (body) => client.presence(body), now: () => clock.now, self: () => single.snapshot()[0] ?? null,
      boards: () => [{ id: board, offset: { ...desk.offset }, region: r(desk.offset.x - 400, desk.offset.y - 400, 6000, 4000) }] });
    // the ONE snapshot of this Desk, as the surface builds it
    const presence = JP.createDeskPresence({ single, joint: () => joint });
    return { who, desk, single, joint, presence, touch: () => { desk.inputAt = clock.now; } };
  }
  const round = async (people, ms = JP.PRESENCE.publishMs) => { clock.now += ms; for (const p of people) { p.touch(); await p.joint.tick(); } };
  return { file, clock, store, board, hub, person, round };
}
// The bridge mirror behind its real HTTP handler (no socket: the same request/response objects the bridge passes).
function bridge(clock, { enabled = true } = {}) {
  const mirror = createPresenceMirror({ now: () => clock.now });
  const handler = createPresenceMirrorHttpHandler({ mirror, enabled: () => enabled });
  const post = async (body, { method = 'POST', headers = {} } = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method, url: PRESENCE_MIRROR.path, headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, setHeader() {}, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); this.writableEnded = true; } });
    assert.equal(await handler(req, res, new URL('http://127.0.0.1:39218' + PRESENCE_MIRROR.path)), true);
    return { status: res.status, body: res.body };
  };
  return { mirror, post };
}
// The owner's canvas: what L4's scene is read from.
const OWNER_VIEW = r(0, 0, 1280, 800); // region A
const CARDS = [{ id: 'own-note', rect: r(100, 100, 500, 400), kind: 'memo', creator: 'user' }, { id: 'own-file', rect: r(1500, 100, 400, 300), kind: 'file', creator: 'user' }];
const FILE = { kind: 'file', size: { width: 720, height: 520 } };
const sceneOf = (rows, tasks) => WP.enumerateWorkScene({ presence: rows, cards: CARDS, tasks, obstacles: [] });
const task = (id, requester, extra = {}) => ({ id, state: 'running', requester, waiting: [], ownerMustAct: false, surfaces: [], ...extra });

test('contract: one snapshot fits both consumers as it is (own row from L4, null viewport for "active" sharers, the same "active" bound)', async (t) => {
  const w = await world(t);
  const a = await w.person('a', { offset: { x: 0, y: 0 }, view: OWNER_VIEW });
  const b = await w.person('b', { offset: { x: 500, y: 300 }, view: r(2900, 500, 1200, 800) });
  const c = await w.person('c', { offset: { x: -900, y: 40 }, view: r(-800, 100, 1024, 768) });
  // no joint rows yet: the Desk snapshot IS L4's single-user snapshot, row for row
  assert.deepEqual(a.presence.snapshot(), a.single.snapshot());
  assert.deepEqual(a.presence.snapshot(), [{ member: 'self', self: true, active: true, viewport: OWNER_VIEW, focusCard: null, lastInputAgeMs: 0 }]);
  b.joint.setShare(w.board, 'region'); c.joint.setShare(w.board, 'active'); await b.joint.idle(); await c.joint.idle();
  await w.round([a, b, c]); await w.round([a, b, c]);
  const rows = a.presence.snapshot();
  assert.equal(rows.length, 3); for (const row of rows) assert.deepEqual(Object.keys(row), KEYS);
  const [self, ...rest] = rows, region = rest.find((x) => x.viewport), activeOnly = rest.find((x) => !x.viewport);
  assert.deepEqual(self, a.single.snapshot()[0], 'the own row is the single-user provider row, untouched');
  assert.deepEqual([region.active, region.viewport, activeOnly.active, activeOnly.viewport], [true, r(2400, 200, 1200, 800), true, null]);
  assert.deepEqual([region.member, activeOnly.member], [b.joint.aliasOn(w.board), c.joint.aliasOn(w.board)], 'each person knows their own alias and can hand it out with a request');

  // L4: the real normalizer takes the rows; a member without a rectangle is not in the scene (nothing can be placed relative to them)
  const normal = WP.normalizePresence(rows);
  assert.deepEqual(normal.map((m) => [m.member, m.self, m.active]), [['self', true, true], [region.member, false, true]]);
  const scene = sceneOf(rows, [task('run-1', region.member)]);
  assert.deepEqual(scene.members.map((m) => [m.alias, m.self, m.active, m.viewport]), [['M1', true, true, OWNER_VIEW], ['M2', false, true, r(2400, 200, 1200, 800)]]);
  assert.ok(normalizePlacementDto(WP.placementRequest(scene, { taskId: 'run-1', surface: FILE }).dto), 'the closed request built from real presence passes the bridge check');

  // L3: the same rows; a member who shares only "active" is present for the audience rule, viewport or not
  const forC = audienceFacts({ audience: { requester: activeOnly.member, owner: 'self', participants: [activeOnly.member, 'self'] }, presence: rows });
  assert.deepEqual([forC.waiting, forC.addresseePresent, forC.postable], ['requester', true, true]);
  assert.deepEqual(audienceFacts({ presence: rows }).waiting, 'requester', "the default audience ('self') matches the row marked self");

  // the bridge mirror takes exactly these rows and gives them back as the interface
  const { mirror, post } = bridge(w.clock);
  assert.deepEqual(await post({ rows }), { status: 200, body: { status: 'held' } });
  assert.deepEqual(mirror.snapshot(), rows, 'ONE snapshot: what the placement runtime reads in the window is what the heartbeat reads in the bridge');
  assert.deepEqual(normalizePresenceRows(rows).map((x) => x.member), rows.map((x) => x.member));

  // "active" means the same in every row: L4's bound for the own row (5 minutes without input) is the bound for the others too
  a.desk.inputAt = w.clock.now - 299_000;
  assert.equal(a.single.snapshot()[0].active, true); a.desk.inputAt = w.clock.now - 301_000; assert.equal(a.single.snapshot()[0].active, false);
  assert.equal(JP.PRESENCE.activeInputMs, 300_000); assert.equal(PRESENCE_LIMITS.activeInputMs, 300_000); assert.equal(PRESENCE_MIRROR.activeInputMs, 300_000);
  a.touch();
  // L4's idle (20 s) is read from lastInputAgeMs, which travels in 5 s steps: a member idle for 20 s or more is idle for the placement runtime too
  b.desk.inputAt = w.clock.now - 23_000; w.clock.now += JP.PRESENCE.publishMs; await b.joint.tick(); a.touch(); await a.joint.tick();
  const idleScene = sceneOf(a.presence.snapshot(), []);
  assert.deepEqual(idleScene.members.map((m) => [m.alias, m.active, m.idle]), [['M1', true, false], ['M2', true, true]]);
});

test('scenario: owner at A, B (region) asks -> options avoid A and include a spot near B; C (active) counts as present but places nothing; stale and off stop counting', async (t) => {
  const w = await world(t);
  const ledger = sha(w.file);
  const a = await w.person('a', { offset: { x: 0, y: 0 }, view: OWNER_VIEW });                      // the owner, working at region A
  const b = await w.person('b', { offset: { x: 500, y: 300 }, view: r(2900, 500, 1200, 800) });     // looks at Board space (2400,200): another part of the owner's space
  const c = await w.person('c', { offset: { x: -900, y: 40 }, view: r(-800, 100, 1024, 768) });
  const { mirror, post } = bridge(w.clock);
  const push = async () => { const rows = a.presence.snapshot(); assert.equal((await post({ rows })).status, 200); return rows; };
  const B_VIEW = r(2400, 200, 1200, 800); // B's view on the OWNER's canvas
  const steps = [];

  // 0. Nobody shares (default). Both consumers see the owner alone; C and B do not exist for them.
  await w.round([a, b, c]);
  let rows = await push();
  assert.deepEqual(rows.map((x) => x.member), ['self']);
  assert.equal(sceneOf(rows, []).members.length, 1);
  const aliasB = b.joint.aliasOn(w.board), aliasC = c.joint.aliasOn(w.board);
  const audience = (requester) => ({ requester, owner: 'self', participants: [requester, 'self'] });
  assert.deepEqual([audienceFacts({ audience: audience(aliasB), presence: mirror.snapshot() }).waiting, audienceFacts({ audience: audience(aliasC), presence: mirror.snapshot() }).waiting], ['owner', 'owner'],
    'sharing off: invisible to the audience rule (only the owner is there)');
  steps.push(['0 nobody shares', rows.length, 'audience(B)=owner']);

  // 1. B shares the view region and asks the owner's Agent to inspect a file. The viewer must open on the OWNER's Desk.
  b.joint.setShare(w.board, 'region'); await b.joint.idle();
  await w.round([a, b, c]); await w.round([a, b, c]);
  rows = await push();
  assert.deepEqual(rows.map((x) => [x.member, x.active, x.viewport]), [['self', true, OWNER_VIEW], [aliasB, true, B_VIEW]]);
  const scene1 = sceneOf(rows, [task('inspect-1', aliasB)]);
  const request1 = WP.placementRequest(scene1, { taskId: 'inspect-1', surface: FILE });
  const kinds = request1.options.map((o) => o.kind);
  assert.ok(request1.options.length >= 2);
  for (const o of request1.options) {
    assert.equal(hits(o.rect, OWNER_VIEW), false, o.kind + ' is outside region A, where the owner is working');
    assert.equal(o.descriptor.insideView.includes('M1'), false);
    assert.equal(CARDS.some((card) => hits(o.rect, card.rect)), false, o.kind + ' covers none of the owner\'s cards');
  }
  const near = request1.options.find((o) => o.kind === 'near_requester');
  assert.ok(near, 'a spot near B is offered');
  assert.deepEqual([near.rect, near.descriptor.distance, near.descriptor.direction, near.descriptor.insideView], [r(3624, 224, 720, 520), 'near', 'right', []], 'just outside B\'s view, on B\'s side of the space');
  assert.equal(request1.dto.task.requester, 'M2'); assert.equal(request1.fallback.kind, 'near_requester', 'the code\'s own pick is the spot near B');
  assert.ok(normalizePlacementDto(request1.dto));
  assert.ok(!JSON.stringify(request1.dto).includes(aliasB) && !/"x"|"rect"|inspect-1|own-note/.test(JSON.stringify(request1.dto)), 'no alias of the feed, id or coordinate in what may leave the window');
  // the whole placement with a judge, re-read against the live scene: lands near B, never in A
  const placed = await WP.placeSurface({ scene: () => ({ presence: a.presence.snapshot(), cards: CARDS, tasks: [task('inspect-1', aliasB)] }), request: { taskId: 'inspect-1', surface: FILE },
    judge: (dto) => dto.options.find((o) => o.kind === 'near_requester').alias });
  assert.deepEqual([placed.source, placed.rect, hits(placed.rect, OWNER_VIEW)], ['decision', r(3624, 224, 720, 520), false]);
  // and the owner's own next surface keeps out of B's view
  const own = WP.placementRequest(sceneOf(rows, [task('own-1', null)]), { taskId: 'own-1', surface: FILE });
  for (const o of own.options) assert.equal(hits(o.rect, B_VIEW), false, 'nothing of the owner\'s work opens where B is looking');
  assert.equal(audienceFacts({ audience: audience(aliasB), presence: mirror.snapshot() }).waiting, 'requester', 'B is waiting and present');
  steps.push(['1 B region + asks', kinds.join(','), 'near B at 3624,224; none in A']);

  // 2. C shares only "active": present for the audience rule, no region for the placement runtime.
  c.joint.setShare(w.board, 'active'); await c.joint.idle();
  await w.round([a, b, c]); await w.round([a, b, c]);
  rows = await push();
  const rowC = rows.find((x) => x.member === aliasC);
  assert.deepEqual([rowC.active, rowC.viewport, rowC.focusCard], [true, null, null]);
  const factsC = audienceFacts({ audience: audience(aliasC), presence: mirror.snapshot() });
  assert.deepEqual([factsC.waiting, factsC.addresseePresent, factsC.postable], ['requester', true, true], 'C counts as present');
  const scene2 = sceneOf(rows, [task('ask-c', aliasC), task('own-2', null)]);
  assert.deepEqual(scene2.members.map((m) => m.member), ['self', aliasB], 'C has no rectangle, so C is not in the placement scene at all');
  const forC = WP.placementRequest(scene2, { taskId: 'ask-c', surface: FILE }), forOwner = WP.placementRequest(scene2, { taskId: 'own-2', surface: FILE });
  assert.deepEqual(forC.options.map((o) => [o.kind, o.rect]), forOwner.options.map((o) => [o.kind, o.rect]), 'a surface for C\'s request is placed exactly as the owner\'s own would be: nothing is placed relative to C');
  assert.deepEqual(forC.dto.members.map((m) => m.alias), ['M1', 'M2'], 'and nothing about C (not even an alias) is in the placement request');
  for (const o of forC.options) assert.equal(hits(o.rect, B_VIEW), false, 'B\'s view stays protected meanwhile');
  steps.push(['2 C active only', 'audience(C)=requester present', 'scene members=2']);

  // 2b. the same rule inside the real chat runtime (L3), reading the mirror: C asked in a conversation with the owner
  {
    const hb = heartbeatWorld(t, { presence: mirror, audience: () => audience(aliasC) });
    const d = await hb.dm('dm-with-c');
    await hb.advance(2000); await d.tool('s1', 'started'); await hb.advance(18_000);
    const seen = d.beats.at(-1).sources.audience;
    assert.deepEqual([seen.waiting, seen.addresseePresent, seen.postable], ['requester', true, true]);
    assert.match(hb.flowAsked[0].own, /Waiting for this: the person who asked; they are at the desk/); // L3 c15: said in a sentence of the judge's material
    assert.ok(!JSON.stringify([hb.beatRequests, d.beats, hb.flowEntries()]).includes('m-'), 'no presence alias reaches the decision model, the beats or the record');
    await d.final('끝났습니다.');
  }

  // 3. B stops publishing. Within 10 s B is inactive on the owner's Desk and stops constraining placement; within one more post, in the bridge.
  const inB = r(2600, 400, 720, 520);
  assert.equal(WP.placementAllowed(sceneOf(a.presence.snapshot(), []), inB, 'M1'), false, 'while B publishes, B\'s view is closed to the owner\'s surfaces');
  const stopped = w.clock.now;
  await w.round([a, c]); await w.round([a, c]); await w.round([a, c]);
  assert.equal(w.clock.now - stopped, 9000); assert.equal(a.presence.snapshot().find((x) => x.member === aliasB).active, true);
  await w.round([a, c]);
  rows = await push();
  assert.equal(w.clock.now - stopped, 12_000);
  assert.deepEqual(rows.filter((x) => x.member === aliasB).map((x) => x.active), [false], 'inactive within the 10 s bound (seen at the next 3 s read)');
  assert.equal(WP.placementAllowed(sceneOf(rows, []), inB, 'M1'), true, 'an inactive member no longer constrains placement');
  assert.equal(audienceFacts({ audience: audience(aliasB), presence: mirror.snapshot() }).waiting, 'owner', 'and is no longer the waiting person: the owner is');
  for (let i = 0; i < 7; i++) await w.round([a, c]);
  rows = await push();
  assert.equal(rows.some((x) => x.member === aliasB), false, 'after 30 s B is not in the snapshot');
  steps.push(['3 B stops', 'inactive at +12 s read', 'placement in old view allowed']);

  // 4. C turns sharing off: gone for both consumers at the next read.
  c.joint.setShare(w.board, 'off'); await c.joint.idle();
  await w.round([a, c]);
  rows = await push();
  assert.deepEqual(rows.map((x) => x.member), ['self']);
  assert.equal(audienceFacts({ audience: audience(aliasC), presence: mirror.snapshot() }).waiting, 'owner');
  assert.equal(sceneOf(rows, []).members.length, 1);

  // 5. The window stops posting (closed, flag off): the mirror goes quiet after 10 s and the audience rule is back to "no feed", as before.
  w.clock.now += PRESENCE_MIRROR.staleMs; assert.ok(mirror.snapshot());
  w.clock.now += 1; assert.equal(mirror.snapshot(), null);
  assert.deepEqual(audienceFacts({ audience: audience(aliasB), presence: mirror.snapshot() }), audienceFacts({ audience: audience(aliasB) }), 'no feed = today\'s single-user behaviour');
  // nothing of this touched the shared ledger
  assert.equal(sha(w.file), ledger);
  t.diagnostic('STEPS ' + JSON.stringify(steps));
});

test('bridge mirror: closed rows only, loopback JSON POST, off by default, memory only with expiry', async () => {
  const clock = { now: 5_000_000 };
  const good = [{ member: 'self', self: true, active: true, viewport: r(0, 0, 1280, 800), focusCard: 'egd-card-3', lastInputAgeMs: 1200 },
    { member: 'm-' + '1'.repeat(16), self: false, active: true, viewport: null, focusCard: null, lastInputAgeMs: 5000 }];
  const off = bridge(clock, { enabled: false });
  assert.deepEqual(await off.post({ rows: good }), { status: 404, body: { status: 'off' } }); assert.equal(off.mirror.snapshot(), null);
  const on = bridge(clock);
  for (const bad of [{ rows: [] }, { rows: good, extra: 1 }, { rows: [{ ...good[0], title: 'x' }] }, { rows: [{ ...good[0], member: 'a b' }] }, { rows: [{ ...good[0], self: false }] }, { rows: [good[1], good[0]] },
    { rows: [{ ...good[0], viewport: null }] }, { rows: [{ ...good[0], viewport: { ...good[0].viewport, url: 'https://synthetic.invalid' } }] }, { rows: [{ ...good[0], focusCard: 'a card title' }] },
    { rows: [{ ...good[0], lastInputAgeMs: -1 }] }, { rows: [good[0], good[1], good[1]] }, { rows: [good[0], { ...good[1], self: true }] }, { rows: Array.from({ length: 10 }, (_, i) => ({ ...good[1], member: 'm' + i, self: i === 0, viewport: i === 0 ? r(0, 0, 1, 1) : null })) }]) {
    assert.deepEqual(await on.post(bad), { status: 400, body: { status: 'invalid' } }, JSON.stringify(bad).slice(0, 80));
  }
  assert.equal(on.mirror.snapshot(), null, 'a refused post leaves nothing behind');
  assert.equal((await on.post({ rows: good }, { method: 'GET' })).status, 405);
  assert.equal((await on.post({ rows: good }, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await on.post({ rows: good }, { headers: { origin: 'https://other.test' } })).status, 403);
  assert.equal((await on.post({ rows: good }, { headers: { host: 'example.test' } })).status, 403);
  assert.deepEqual(await on.post({ rows: good }), { status: 200, body: { status: 'held' } });
  assert.deepEqual(on.mirror.snapshot(), good);
  clock.now += 4000;
  assert.deepEqual(on.mirror.snapshot().map((x) => x.lastInputAgeMs), [5200, 9000], 'input ages keep running between posts');
  clock.now += 6001; assert.equal(on.mirror.snapshot(), null);
  // an "active" that outlives the bound while the mirror is fresh is dropped by the mirror itself
  await on.post({ rows: [{ ...good[0], lastInputAgeMs: 299_000 }] }); clock.now += 2000;
  assert.deepEqual(on.mirror.snapshot().map((x) => [x.active, x.lastInputAgeMs]), [[false, 301_000]]);
  assert.deepEqual(Object.keys(on.mirror), ['accept', 'snapshot', 'clear'], 'nothing here can write anywhere');
  const src = fs.readFileSync(new URL('./egdesk-presence-mirror.mjs', import.meta.url), 'utf8');
  assert.ok(!/node:fs|node:sqlite|writeFile|setStringPref/.test(src), 'memory only');
});

// ---------- host wiring: the real surface functions, compiled from the source text (the way L4's consumer test does) ----------
const surface = fs.readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url), 'utf8');
const decl = (name) => { const s = surface.indexOf(`  function ${name}(`); assert.ok(s >= 0, name); return surface.slice(s, surface.indexOf('\n  }', s) + 4); };
function host({ pref, jointDesk = null } = {}) {
  const log = { prefs: [], posts: [], listeners: 0, timers: [] };
  const state = { activeEntityId: 'egd-card-1' };
  const deps = { WorkPlacement: WP, JointPresence: JP, state, jointDesk, readSurfacePref: (key) => { log.prefs.push(key); return pref; },
    window: { addEventListener: () => { log.listeners++; }, setInterval: (fn, ms) => { log.timers.push({ fn, ms }); return log.timers.length; } },
    safeViewportWorldRect: () => ({ left: 0, top: 0, right: 1280, bottom: 800 }),
    deskStoreRequest: async (method, pathName, body, options) => { log.posts.push([method, pathName, body, options]); return { status: 200, body: { status: 'held' } }; } };
  const body = `let workInputAt = null, workInputWatch = false;\n${decl('workPresence')}\n${decl('installDeskPresence')}\nreturn { workPresence, installDeskPresence };`;
  return { ...new Function(...Object.keys(deps), body)(...Object.values(deps)), log, state };
}
test('host wiring, default path: with the flag unset only the pref is read; the window answers as a single user exactly as before', () => {
  for (const pref of [undefined, null, 'off', 'ON', 'advisory', true, { unreadable: true }]) {
    const h = host({ pref });
    assert.equal(h.installDeskPresence(), null, String(pref));
    assert.deepEqual(h.log, { prefs: ['egdesk.presence'], posts: [], listeners: 0, timers: [] }, String(pref));
    assert.deepEqual(Object.keys(h.state), ['activeEntityId'], 'no state.presence, no timer, no own-row hook');
    const rows = h.workPresence().snapshot();
    assert.deepEqual(rows.map((x) => [x.member, x.self, x.viewport]), [['self', true, r(0, 0, 1280, 800)]], 'L4\'s single-user provider, untouched');
  }
  // the joint Board view gets the own row only when the flag installed it, and the per-Board choice is a private pref of this profile
  assert.match(surface, /\.\.\.\(typeof state\.presenceSelf === 'function' \? \{ selfPresence: state\.presenceSelf \} : \{\}\),\n\s+readPresenceShare: \(\) => readSurfacePref\(JointPresence\.PRESENCE_SHARE_PREF\),\n\s+writePresenceShare: \(v\) => writeSurfacePref\(JointPresence\.PRESENCE_SHARE_PREF, v\),/);
  assert.match(surface, /try \{ installDeskPresence\(\); \} catch \{/);
  assert.equal(JP.PRESENCE_PREF, 'egdesk.presence'); assert.equal(JP.PRESENCE_SHARE_PREF, 'egdesk.jointBoard.presenceShare.v1');
  // L4's function is as L4 wrote it: it prefers state.presence when one exists
  assert.match(decl('workPresence'), /if \(typeof state\.presence\?\.snapshot === 'function'\) return state\.presence;/);
  // bridge side: both flags, both default off
  const server = fs.readFileSync(new URL('./codex-bridge-server.mjs', import.meta.url), 'utf8');
  assert.match(server, /createPresenceMirrorHttpHandler\(\{ mirror: presenceMirror, enabled: \(\) => process\.env\.EGDESK_PRESENCE === 'on', port: BRIDGE_PORT \}\)/);
  // The presence spread stays gated by EGDESK_PRESENCE inside the conversation-flow config; other lanes may add further properties after it (e.g. L3's attentionPosted).
  assert.match(server, /process\.env\.EGDESK_CONVERSATION_FLOW === 'on' \? \{ conversationFlow: \{ mode: \(\) => 'on', \.\.\.\(process\.env\.EGDESK_PRESENCE === 'on' \? \{ presence: presenceMirror, audience: \(\{ run \}\) => runRequesters\.audience\(\{ run \}\) \} : \{\}\)(?:,[^\n]*\n[^\n]*)? \} \} : \{\}/);
  assert.match(server, /if \(await handlePresenceMirrorHttp\(req, res, url\)\) return/);
});
test('host wiring, flag on: ONE state.presence for the placement runtime and the bridge mirror; own row from the single-user provider; joint rows when a Board feed exists', async () => {
  const remote = { member: 'm-' + 'a'.repeat(16), self: false, active: true, viewport: r(2400, 200, 1200, 800), focusCard: null, lastInputAgeMs: 5000 };
  const quiet = { member: 'm-' + 'b'.repeat(16), self: false, active: true, viewport: null, focusCard: null, lastInputAgeMs: 0 };
  // no joint Board UI yet
  const alone = host({ pref: 'on' });
  const presence = alone.installDeskPresence();
  assert.ok(presence && alone.state.presence === presence); assert.equal(alone.installDeskPresence(), null, 'installed once');
  assert.equal(alone.workPresence(), presence, 'the placement runtime now reads the same object');
  assert.deepEqual(presence.snapshot().map((x) => [x.member, x.self]), [['self', true]]);
  assert.deepEqual(alone.state.presenceSelf(), presence.snapshot()[0], 'the own row handed to the joint provider is the single-user row');
  assert.deepEqual([alone.log.prefs, alone.log.listeners, alone.log.timers.map((x) => x.ms)], [['egdesk.presence'], 3, [3000]], 'input is watched and the mirror is fed every 3 s only once the flag is on');
  // with a joint Board feed
  const jointDesk = { presence: { rows: null, snapshot() { return this.rows; } } };
  const shared = host({ pref: 'on', jointDesk });
  const both = shared.installDeskPresence();
  jointDesk.presence.rows = [shared.state.presenceSelf(), remote, quiet];
  assert.deepEqual(both.snapshot(), jointDesk.presence.rows);
  assert.deepEqual(WP.normalizePresence(shared.workPresence().snapshot()).map((m) => m.member), ['self', remote.member]);
  jointDesk.presence.rows = []; assert.deepEqual(both.snapshot().map((x) => x.member), ['self'], 'no joint rows (not connected): the single-user rows');
  jointDesk.presence.rows = [remote]; assert.deepEqual(both.snapshot().map((x) => x.member), ['self'], 'a feed without the own row first is not used');
  jointDesk.presence.snapshot = () => { throw new Error('x'); }; assert.deepEqual(both.snapshot().map((x) => x.member), ['self']);
  // the mirror post: the same rows, in the closed shape the bridge accepts
  jointDesk.presence.snapshot = () => [shared.state.presenceSelf(), remote, quiet];
  shared.log.timers[0].fn(); await Promise.resolve();
  const [method, pathName, body, options] = shared.log.posts[0];
  assert.deepEqual([method, pathName, Object.keys(body), options], ['POST', PRESENCE_MIRROR.path, ['rows'], { timeoutMs: 4000 }]);
  assert.deepEqual(body.rows, both.snapshot()); assert.ok(normalizePresenceRows(body.rows));
});

// ---------- the per-Board sharing choice: this person's own private settings ----------
function prefBacking() { // readSurfacePref / writeSurfacePref over one string pref, as the surface does
  const box = { raw: '', writes: 0 };
  return { box, read: () => { try { return box.raw ? JSON.parse(box.raw) : null; } catch { return { unreadable: true }; } }, write: (v) => { box.raw = JSON.stringify(v); box.writes++; } };
}
test('the sharing choice is private, per Board and per seat, default off, and a restart keeps it', async (t) => {
  const w = await world(t);
  const ledger = sha(w.file);
  const scope = w.store.view('a').instance + '/a', seat = { id: w.board, epoch: w.store.view('a').boards[0].epoch };
  const pref = prefBacking();
  const session = () => { // one run of the window: the store over the pref, the presence module, the choice read after connecting
    const store = JP.createShareStore({ read: pref.read, write: pref.write });
    const presence = JP.createJointPresence({ send: async () => { throw new Error('offline'); }, self: () => null, boards: () => [], onShareChange: (levels) => store.save(scope, levels, [seat]) });
    presence.loadShare(store.prune(scope, [seat]));
    return { store, presence };
  };
  // default: off, and reading it writes nothing
  let run = session();
  assert.equal(run.presence.share(w.board), 'off'); assert.deepEqual(pref.box, { raw: '', writes: 0 });
  // choose "region": saved under this person's scope, with the seat it was made on
  assert.equal(run.presence.setShare(w.board, 'region'), true);
  assert.deepEqual(JSON.parse(pref.box.raw), { [scope]: { [w.board]: { level: 'region', epoch: seat.epoch } } });
  // restart: a new window reads the same pref
  run = session();
  assert.equal(run.presence.share(w.board), 'region', 'the choice survives a restart');
  assert.equal(pref.box.writes, 1, 'reading it back writes nothing');
  run.presence.setShare(w.board, 'active'); run = session(); assert.equal(run.presence.share(w.board), 'active');
  // turning it off removes the entry: "off" is the absence of a choice, never a stored value
  run.presence.setShare(w.board, 'off');
  assert.equal(pref.box.raw, '{}'); run = session(); assert.equal(run.presence.share(w.board), 'off');
  // another account on the same machine, another seat (left and joined again), a Board no longer seated, a corrupt pref: all off
  run.presence.setShare(w.board, 'region');
  const store = JP.createShareStore({ read: pref.read, write: pref.write });
  assert.deepEqual(store.load(scope.replace('/a', '/b'), [seat]), {});
  assert.deepEqual(store.load(scope, [{ ...seat, epoch: randomUUID() }]), {});
  assert.deepEqual(store.load(scope, []), {});
  pref.box.raw = JSON.stringify({ [scope]: { [w.board]: { level: 'region', epoch: seat.epoch } }, 'other/scope': { [randomUUID()]: { level: 'active', epoch: 'e' } } });
  assert.deepEqual(store.prune(scope, [{ ...seat, epoch: 'new-seat' }]), {}, 'a choice made on an earlier seat is not carried over');
  assert.deepEqual(Object.keys(JSON.parse(pref.box.raw)), ['other/scope'], '...and is removed from the pref; other scopes are left alone');
  for (const raw of ['{broken', '[]', '"on"', JSON.stringify({ [scope]: 'region' }), JSON.stringify({ [scope]: { [w.board]: { level: 'everything', epoch: seat.epoch } } }), JSON.stringify({ [scope]: { [w.board]: { level: 'off', epoch: seat.epoch } } })]) {
    pref.box.raw = raw; assert.deepEqual(JP.createShareStore({ read: pref.read, write: pref.write }).load(scope, [seat]), {}, raw);
  }
  // signing out of the service on this Desk forgets the choice
  pref.box.raw = JSON.stringify({ [scope]: { [w.board]: { level: 'region', epoch: seat.epoch } } });
  store.forget(scope); assert.equal(pref.box.raw, '{}');
  // without a host store the choice lives in the window only
  const memory = JP.createShareStore(); memory.save(scope, { [w.board]: 'active' }, [seat]); assert.deepEqual(memory.load(scope, [seat]), { [w.board]: 'active' }); assert.deepEqual(JP.createShareStore().load(scope, [seat]), {});
  // the service never saw a setting and the shared ledger is what it was
  assert.equal(w.hub.size(), 0); assert.equal(sha(w.file), ledger);
  // the joint Board view wires exactly this store, bound to the seats of the current view, and forgets on sign-out
  const view = fs.readFileSync(new URL('../overlay/resources/EGDeskJointBoardView.sys.mjs', import.meta.url), 'utf8');
  assert.match(view, /onShareChange: \(levels\) => \{ if \(instanceScope\) shareStore\.save\(instanceScope, levels, seats\(\)\); \}/);
  assert.match(view, /presence\.loadShare\(shareStore\.prune\(ns, seatList\)\);/);
  assert.match(view, /h\.writeLayout\(local\);\n\s+shareStore\.forget\(instanceScope\);/);
  assert.match(view, /presence\.loadShare\(\{\}\); \/\/ no verified session/);
});
