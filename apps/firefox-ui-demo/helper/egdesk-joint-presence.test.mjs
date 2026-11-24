// Multi-user presence on the local joint Board service (loopback only, synthetic members).
// Real pieces: joint store (SQLite file), the HTTP handler on a 127.0.0.1 socket, the presence hub, the joint client's
// presence call and the multi-user presence module. Synthetic: the people, their Desks (offset, viewport, focus), the clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createJointStore } from './egdesk-joint-board-store.mjs';
import { jointHttp, startJointServer, startJointTlsServer } from './egdesk-joint-board-server.mjs';
import { createJointPresence as createHub, PRESENCE_LIMITS } from './egdesk-joint-presence.mjs';
import { createJointClient } from '../overlay/resources/EGDeskJointBoardClient.sys.mjs';
import { createJointPresence, checkedPresence, projectionPresence, PRESENCE, SHARE_LEVELS } from '../overlay/resources/EGDeskJointPresence.sys.mjs';

const BOARD_TITLE = 'zeta-synthetic-board-title';
const CARD_TITLE = 'zeta-synthetic-card-title', CARD_BODY = 'zeta-synthetic-card-body https://synthetic.invalid/path';
const NAMES = { a: 'Zeta Person A', b: 'Zeta Person B', c: 'Zeta Person C', d: 'Zeta Person D', e: 'Zeta Person E' };
const ALIAS = /^m-[0-9a-f]{16}$/;
const KEYS = ['member', 'self', 'active', 'viewport', 'focusCard', 'lastInputAgeMs'];
const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function world(t, { defaultServer = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-presence-'));
  const file = path.join(dir, 'joint.sqlite');
  const clock = { now: 1_800_000_000_000 };
  const real = createJointStore(file, { now: () => clock.now });
  // Every write path of the authority is counted: presence must never reach one.
  const writes = { mutate: 0, stepApp: 0, issueAccount: 0 };
  const store = { ...real, mutate: (...a) => { writes.mutate++; return real.mutate(...a); }, stepApp: (...a) => { writes.stepApp++; return real.stepApp(...a); },
    issueAccount: (...a) => { writes.issueAccount++; return real.issueAccount(...a); } };
  const keys = {};
  for (const p of Object.keys(NAMES)) keys[p] = real.issueAccount(p, NAMES[p]);
  const act = (p, action, o = {}) => real.mutate(p, { action, ...o, request: randomUUID() });
  const form = act('a', 'propose', { to: 'b', title: BOARD_TITLE }).sent[0];
  const board = act('b', 'accept', { invite: form.id }).boards[0].id;
  act('a', 'inviteBoard', { board, to: 'c' });
  act('c', 'accept', { invite: real.view('c').invites[0].id });
  const k1 = act('a', 'addCard', { board, title: CARD_TITLE, body: CARD_BODY, kind: 'task' }).boards[0].cards[0];
  const k2 = act('a', 'addCard', { board, title: CARD_TITLE + ' 2', body: CARD_BODY, kind: 'note' }).boards[0].cards[1];
  act('a', 'share', { card: k1.id, version: 1, to: 'b', scope: 'board' }); // K1: a and b only
  act('a', 'share', { card: k2.id, version: 1, to: 'b', scope: 'board' });
  act('a', 'share', { card: k2.id, version: 1, to: 'c', scope: 'board' }); // K2: a, b and c
  act('a', 'share', { card: k2.id, version: 1, to: 'd', scope: 'single' }); // d: one card only, no seat on the Board
  act('d', 'accept', { invite: real.view('d').invites[0].id });
  const hub = createHub({ access: store.presenceAccess, now: () => clock.now });
  const wire = [];
  const server = defaultServer ? await startJointServer(store, 0)
    : await new Promise((resolve) => { const h = http.createServer(jointHttp(store, { presence: hub })); h.listen(0, '127.0.0.1', () => resolve(h)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); try { real.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  const raw = async (who, body, { key = keys[who], headers = {}, text = null } = {}) => {
    const res = await fetch(origin + '/v1/joint/presence', { method: 'POST', headers: { ...(key ? { Authorization: 'Bearer ' + key } : {}), 'Content-Type': 'application/json', ...headers },
      body: text ?? JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };
  // One synthetic person: the real joint client + the real presence module over a synthetic Desk.
  async function person(who, { offset, viewport, region = { x: offset.x - 400, y: offset.y - 400, width: 4000, height: 3000 }, visibleCards = [] }) {
    const desk = { offset, viewport, region, focusCard: null, lastInputAgeMs: 0, active: true, link: true };
    const layoutWrites = [];
    const client = createJointClient({
      request: async (url, init) => {
        if (!desk.link) throw new Error('offline');
        const res = await fetch(url, init);
        if (url.endsWith('/presence')) { const copy = res.clone(); wire.push({ who, sent: JSON.parse(init.body), status: res.status, got: await copy.json().catch(() => null) }); }
        return res;
      },
      timeoutSignal: () => AbortSignal.timeout(7000), uuid: randomUUID, apply() {}, unavailable() {},
    });
    await client.connect(origin, keys[who]);
    const alias = (id) => 'view-' + who + '-' + id.slice(0, 8);
    const presence = createJointPresence({
      send: (body) => client.presence(body), now: () => clock.now,
      self: () => ({ member: 'me', self: true, active: desk.active, viewport: { ...desk.viewport }, focusCard: desk.focusCard, lastInputAgeMs: desk.lastInputAgeMs }),
      boards: () => [{ id: board, offset: { ...desk.offset }, region: desk.region && { ...desk.region } }],
      cardAlias: (b, id) => (b === board && visibleCards.includes(id) ? alias(id) : null),
      cardId: (local) => { const id = visibleCards.find((k) => alias(k) === local); return id ? { board, card: id } : null; },
      onShareChange: (value) => layoutWrites.push(value),
    });
    return { who, desk, client, presence, alias, layoutWrites };
  }
  const tickAll = async (people, ms = PRESENCE.publishMs) => { clock.now += ms; for (const p of people) await p.presence.tick(); };
  return { dir, file, clock, real, store, writes, keys, act, board, k1: k1.id, k2: k2.id, hub, server, origin, wire, raw, person, tickAll };
}
const others = (snapshot) => snapshot.filter((row) => !row.self);

test('publish and receive between three members: opt-in levels, converted rectangles, focus card only for those who can see it', async (t) => {
  const w = await world(t);
  const a = await w.person('a', { offset: { x: 1000, y: 500 }, viewport: { x: 1200, y: 700, width: 800, height: 600 }, visibleCards: [w.k1, w.k2] });
  const b = await w.person('b', { offset: { x: -300, y: 200 }, viewport: { x: 0, y: 400, width: 1280, height: 720 }, visibleCards: [w.k1, w.k2] });
  const c = await w.person('c', { offset: { x: 0, y: 0 }, viewport: { x: 40, y: 80, width: 1600, height: 880 }, visibleCards: [w.k2] });
  const all = [a, b, c];

  // 1. Default: nobody shares. Each person sees only their own row; the service holds nothing.
  await w.tickAll(all);
  for (const p of all) {
    assert.equal(p.presence.share(w.board), 'off');
    const snap = p.presence.snapshot();
    assert.equal(snap.length, 1); assert.deepEqual(Object.keys(snap[0]), KEYS);
    assert.deepEqual(snap[0], { member: 'me', self: true, active: true, viewport: p.desk.viewport, focusCard: null, lastInputAgeMs: 0 }, 'the own row is the single-user provider row, unchanged');
  }
  assert.equal(w.hub.size(), 0);
  assert.deepEqual(w.wire.map((x) => x.sent), [{ board: w.board, share: 'off' }, { board: w.board, share: 'off' }, { board: w.board, share: 'off' }], 'with sharing off nothing about the person leaves');
  assert.ok(w.wire.every((x) => x.status === 200 && x.got.members.length === 0));

  // 2. a shares the view region and focuses K1; b shares only "active"; c stays off.
  assert.equal(a.presence.setShare(w.board, 'region'), true); assert.equal(b.presence.setShare(w.board, 'active'), true);
  await a.presence.idle(); await b.presence.idle();
  assert.equal(w.hub.size(), 0, 'the immediate exchange fell inside the one-per-second limit, so nothing is published before the next cadence');
  assert.deepEqual(w.wire.slice(-2).map((x) => x.status), [429, 429]);
  a.desk.focusCard = a.alias(w.k1); a.desk.lastInputAgeMs = 2300; b.desk.lastInputAgeMs = 12_900; b.desk.focusCard = b.alias(w.k2);
  await w.tickAll(all); await w.tickAll(all); // second round so everybody has read after everybody published
  assert.equal(w.hub.size(), 2);
  const [fromA] = others(c.presence.snapshot()).filter((r) => r.viewport), sent = w.wire.filter((x) => x.who === 'a').at(-1).sent;
  assert.deepEqual(sent, { board: w.board, share: 'region', inputAgeMs: 2300, viewport: { x: 200, y: 200, width: 800, height: 600 }, focusCard: w.k1 }, 'a publishes the rectangle in the Board card-position space (canvas minus own offset)');
  assert.deepEqual(w.wire.filter((x) => x.who === 'b').at(-1).sent, { board: w.board, share: 'active', inputAgeMs: 12_900 }, 'the "active" level carries no rectangle and no card');
  // c: sees a (rectangle in c's own canvas coordinates; K1 is not visible to c, so no focus card) and b (active, no rectangle)
  const cSnap = c.presence.snapshot();
  assert.equal(cSnap.length, 3); for (const row of cSnap) assert.deepEqual(Object.keys(row), KEYS);
  assert.deepEqual({ ...fromA, member: 'x' }, { member: 'x', self: false, active: true, viewport: { x: 200, y: 200, width: 800, height: 600 }, focusCard: null, lastInputAgeMs: 0 });
  const fromB = others(cSnap).find((r) => !r.viewport);
  assert.deepEqual({ ...fromB, member: 'x' }, { member: 'x', self: false, active: true, viewport: null, focusCard: null, lastInputAgeMs: 10_000 }, 'input age arrives in 5 s steps (12.9 s -> 10 s), never the exact value');
  w.clock.now += 2000; // no new answer: the reader adds its own waiting time
  assert.deepEqual(others(c.presence.snapshot()).map((r) => r.lastInputAgeMs).sort((x, y) => x - y), [2000, 12_000]);
  w.clock.now -= 2000;
  // b: the same rectangle lands at b's own offset, and b can see K1, so the focus card arrives as b's own alias for it
  const bFromA = others(b.presence.snapshot()).find((r) => r.viewport);
  assert.deepEqual(bFromA.viewport, { x: 200 - 300, y: 200 + 200, width: 800, height: 600 }); assert.equal(bFromA.focusCard, b.alias(w.k1));
  // a: sees b only as active; c (off) is not there at all
  assert.deepEqual(others(a.presence.snapshot()).map((r) => [r.active, r.viewport, r.focusCard]), [[true, null, null]]);
  // aliases: opaque, distinct, the same for every reader, never an account id or a name
  const aliasOfA = fromA.member, aliasOfB = fromB.member;
  assert.match(aliasOfA, ALIAS); assert.match(aliasOfB, ALIAS); assert.notEqual(aliasOfA, aliasOfB); assert.equal(bFromA.member, aliasOfA);
  // a focuses K2 (visible to c): now c gets its own alias for that card
  a.desk.focusCard = a.alias(w.k2); await w.tickAll(all); await w.tickAll(all);
  assert.equal(others(c.presence.snapshot()).find((r) => r.viewport).focusCard, c.alias(w.k2));

  // 3. a looks at another part of the own Desk (no overlap with this Board's region): still active, but no rectangle and no card leave
  a.desk.viewport = { x: 90_000, y: 90_000, width: 800, height: 600 }; await w.tickAll(all); await w.tickAll(all);
  assert.deepEqual(w.wire.filter((x) => x.who === 'a').at(-1).sent, { board: w.board, share: 'region', inputAgeMs: 2300, viewport: null, focusCard: null });
  assert.deepEqual(others(c.presence.snapshot()).filter((r) => r.member === aliasOfA).map((r) => [r.active, r.viewport, r.focusCard]), [[true, null, null]]);

  // 4. Content-free on the wire, both directions, for the whole session.
  const text = JSON.stringify(w.wire);
  for (const secret of [BOARD_TITLE, CARD_TITLE, 'zeta-synthetic-card-body', 'synthetic.invalid', ...Object.values(NAMES), 'pointer', 'cursor', 'title', 'url', 'jb1.']) assert.equal(text.includes(secret), false, 'never on the wire: ' + secret);
  for (const key of Object.values(w.keys)) assert.equal(text.includes(key), false);
  for (const x of w.wire) {
    assert.ok(Object.keys(x.sent).every((k) => ['board', 'share', 'inputAgeMs', 'viewport', 'focusCard'].includes(k)));
    if (x.status !== 200) { assert.deepEqual([x.status, x.got], [429, { error: 'presence-rate' }]); continue; }
    assert.deepEqual(Object.keys(x.got), ['version', 'board', 'self', 'share', 'staleMs', 'expireMs', 'members']);
    for (const m of x.got.members) assert.deepEqual(Object.keys(m), ['member', 'active', 'inputAgeMs', 'ageMs', 'viewport', 'focusCard']);
    assert.doesNotMatch(JSON.stringify(x.got.members), /"(a|b|c|d|e)"/);
  }
  // 5. Turning sharing off withdraws the record at once.
  a.presence.setShare(w.board, 'off'); await a.presence.idle();
  assert.equal(w.hub.size(), 1, 'withdrawn by the immediate exchange (even though that call was rate limited)');
  await w.tickAll(all);
  assert.equal(others(c.presence.snapshot()).some((r) => r.member === aliasOfA), false);
  assert.deepEqual(a.layoutWrites.at(-1), {}, 'the setting change is reported to the host; nothing else is written anywhere');
});

test('a non-member receives nothing and cannot publish: single-card recipient, unrelated account, no key, wrong route', async (t) => {
  const w = await world(t);
  const a = await w.person('a', { offset: { x: 0, y: 0 }, viewport: { x: 0, y: 0, width: 800, height: 600 }, visibleCards: [w.k1, w.k2] });
  a.presence.setShare(w.board, 'region'); await a.presence.idle(); await w.tickAll([a]);
  assert.equal(w.hub.size(), 1);
  for (const who of ['d', 'e']) {
    for (const body of [{ board: w.board, share: 'off' }, { board: w.board, share: 'region', inputAgeMs: 0, viewport: { x: 0, y: 0, width: 40, height: 40 }, focusCard: w.k2 }]) {
      w.clock.now += 5000;
      assert.deepEqual(await w.raw(who, body), { status: 404, body: { error: 'unavailable' } }, who + ' is not seated on the Board');
    }
    // the same person through the client module: only their own row, ever
    const p = await w.person(who, { offset: { x: 0, y: 0 }, viewport: { x: 0, y: 0, width: 800, height: 600 }, visibleCards: [w.k2] });
    p.presence.setShare(w.board, 'region'); await p.presence.idle(); await w.tickAll([p]); await w.tickAll([p]);
    assert.deepEqual(p.presence.snapshot().map((r) => r.self), [true]);
  }
  assert.equal(w.hub.size(), 1, 'nothing of a non-member was stored');
  assert.deepEqual(await w.raw('a', { board: randomUUID(), share: 'off' }), { status: 404, body: { error: 'unavailable' } }, 'an unknown Board answers like a Board one is not on');
  assert.equal((await w.raw('a', { board: w.board, share: 'off' }, { key: null })).status, 401);
  assert.equal((await w.raw('a', { board: w.board, share: 'off' }, { key: 'jb1.' + 'x'.repeat(43) })).status, 401);
  assert.equal((await w.raw('a', { board: w.board, share: 'off' }, { headers: { Origin: 'https://other.test' } })).status, 403);
  assert.equal((await fetch(w.origin + '/v1/joint/presence', { headers: { Authorization: 'Bearer ' + w.keys.a } })).status, 404, 'no GET');
  // a presence body is not a Board action and a Board action is not presence
  assert.equal((await fetch(w.origin + '/v1/joint/action', { method: 'POST', headers: { Authorization: 'Bearer ' + w.keys.a, 'Content-Type': 'application/json' },
    body: JSON.stringify({ board: w.board, share: 'region', request: randomUUID() }) })).status, 400);
  assert.equal(w.writes.mutate, 1, 'only that deliberate, rejected Board action reached the ledger path');
  // a network-reachable (TLS) service has no presence route unless the operator asks for it; a service without a hub has none either
  const bare = await new Promise((resolve) => { const h = http.createServer(jointHttp(w.store)); h.listen(0, '127.0.0.1', () => resolve(h)); });
  t.after(() => { bare.closeAllConnections(); bare.close(); });
  const res = await fetch('http://127.0.0.1:' + bare.address().port + '/v1/joint/presence', { method: 'POST', headers: { Authorization: 'Bearer ' + w.keys.a, 'Content-Type': 'application/json' }, body: JSON.stringify({ board: w.board, share: 'off' }) });
  assert.equal(res.status, 404);
  assert.match(startJointTlsServer.toString(), /presence = false/);
});

test('what a publish may contain: closed fields, the sharing level decides, coarse rectangle and input age, rate limit', async (t) => {
  const w = await world(t);
  const ok = { board: w.board, share: 'region', inputAgeMs: 7300, viewport: { x: 205, y: 199, width: 790, height: 601 }, focusCard: w.k1 };
  const step = () => { w.clock.now += PRESENCE_LIMITS.minIntervalMs; };
  // anything beyond the closed fields is refused and nothing is kept
  for (const extra of [{ title: CARD_TITLE }, { text: 'hello' }, { url: 'https://synthetic.invalid' }, { pointer: { x: 1, y: 2 } }, { cursor: [1, 2] }, { name: NAMES.a }, { member: 'm-0000000000000000' }, { active: true }]) {
    step(); assert.deepEqual(await w.raw('a', { ...ok, ...extra }), { status: 400, body: { error: 'invalid-presence' } }, JSON.stringify(extra));
  }
  for (const bad of [{ ...ok, viewport: { ...ok.viewport, label: 'x' } }, { ...ok, viewport: { x: 0, y: 0, width: 0, height: 10 } }, { ...ok, viewport: { x: 0, y: 0, width: 90_000, height: 10 } }, { ...ok, viewport: { x: 50_000, y: 0, width: 10, height: 10 } },
    { ...ok, viewport: 'everything' }, { ...ok, inputAgeMs: -1 }, { ...ok, inputAgeMs: 1.5 }, { ...ok, inputAgeMs: '0' }, { ...ok, focusCard: 'K1' }, { ...ok, share: 'everything' }, { ...ok, board: 'x' }, [ok], 'region',
    { board: w.board, share: 'active', inputAgeMs: 0, viewport: ok.viewport }, { board: w.board, share: 'active', inputAgeMs: 0, focusCard: w.k1 }, { board: w.board, share: 'off', inputAgeMs: 0 }, { board: w.board, share: 'off', viewport: ok.viewport }]) {
    step(); assert.deepEqual(await w.raw('a', bad), { status: 400, body: { error: 'invalid-presence' } }, JSON.stringify(bad));
  }
  step(); assert.equal((await w.raw('a', { ...ok, pad: 'x'.repeat(3000) })).status, 413);
  step(); assert.deepEqual(await w.raw('a', null, { text: '{not json' }), { status: 400, body: { error: 'invalid-json' } });
  assert.equal(w.hub.size(), 0);
  // accepted: rectangle rounded outward to the 40-unit grid, input age in 5 s steps
  step(); assert.equal((await w.raw('a', ok)).status, 200);
  step(); const seen = (await w.raw('b', { board: w.board, share: 'off' })).body.members;
  assert.deepEqual(seen, [{ member: seen[0].member, active: true, inputAgeMs: 5000, ageMs: 1000, viewport: { x: 200, y: 160, width: 800, height: 640 }, focusCard: w.k1 }]);
  assert.ok(seen[0].viewport.x <= 205 && seen[0].viewport.x + seen[0].viewport.width >= 205 + 790 && seen[0].viewport.y <= 199 && seen[0].viewport.y + seen[0].viewport.height >= 199 + 601, 'the coarse rectangle covers the real one');
  step(); assert.equal((await w.raw('c', { board: w.board, share: 'off' })).body.members[0].focusCard, null, 'c cannot see K1, so c is not told it is focused');
  // a card the publisher cannot see (or of no Board) is not kept
  step(); await w.raw('c', { board: w.board, share: 'region', inputAgeMs: 0, viewport: { x: 0, y: 0, width: 40, height: 40 }, focusCard: w.k1 });
  step(); const fromC = (await w.raw('a', { ...ok })).body.members; assert.deepEqual(fromC.map((m) => m.focusCard), [null]);
  // input age is capped, and a long-idle member is listed but not active
  step(); await w.raw('c', { board: w.board, share: 'active', inputAgeMs: 9_999_999 });
  step(); assert.deepEqual((await w.raw('b', { board: w.board, share: 'off' })).body.members.filter((m) => m.member === fromC[0].member).map((m) => [m.active, m.inputAgeMs, m.viewport]), [[false, PRESENCE_LIMITS.inputCapMs, null]]);
  // rate limit: at most one exchange per second per member and Board; a refused call changes nothing
  step(); assert.equal((await w.raw('a', { ...ok, viewport: { x: 0, y: 0, width: 40, height: 40 } })).status, 200);
  assert.deepEqual(await w.raw('a', { ...ok, viewport: { x: 4000, y: 4000, width: 40, height: 40 } }), { status: 429, body: { error: 'presence-rate' } });
  w.clock.now += PRESENCE_LIMITS.minIntervalMs - 1; assert.equal((await w.raw('a', ok)).status, 429);
  step(); assert.deepEqual((await w.raw('b', { board: w.board, share: 'off' })).body.members.find((m) => m.viewport)?.viewport, { x: 0, y: 0, width: 40, height: 40 });
  // ...except withdrawal: "off" removes the record even inside the rate-limited second
  step(); assert.equal((await w.raw('a', ok)).status, 200);
  assert.equal((await w.raw('a', { board: w.board, share: 'off' })).status, 429);
  step(); assert.equal((await w.raw('b', { board: w.board, share: 'off' })).body.members.some((m) => m.viewport), false, 'withdrawn although the call itself was rate limited');
  // the answer checker of the client refuses anything outside the closed shape
  const good = { version: 1, board: w.board, self: 'm-' + '0'.repeat(16), share: 'off', staleMs: 1, expireMs: 2, members: [{ member: 'm-' + '1'.repeat(16), active: true, inputAgeMs: 0, ageMs: 0, viewport: null, focusCard: null }] };
  assert.equal(checkedPresence(good, w.board).members.length, 1);
  for (const broken of [{ ...good, members: [{ ...good.members[0], name: NAMES.a }] }, { ...good, members: [{ ...good.members[0], member: 'a' }] }, { ...good, members: [{ ...good.members[0], viewport: { x: 0, y: 0, width: 1, height: 1, title: 'x' } }] },
    { ...good, members: [{ ...good.members[0], focusCard: 'https://synthetic.invalid' }] }, { ...good, board: randomUUID() }, { ...good, title: 'x' }, { ...good, members: [good.members[0], good.members[0]] }, null]) {
    assert.throws(() => checkedPresence(broken, w.board), /invalid-presence/);
  }
  assert.deepEqual([...SHARE_LEVELS], ['off', 'active', 'region']);
});

test('staleness and expiry: a member who stops publishing turns inactive after 10 s and disappears after 30 s; so does a reader who loses the link', async (t) => {
  const w = await world(t);
  const a = await w.person('a', { offset: { x: 0, y: 0 }, viewport: { x: 0, y: 0, width: 800, height: 600 }, visibleCards: [w.k1, w.k2] });
  const b = await w.person('b', { offset: { x: 0, y: 0 }, viewport: { x: 0, y: 0, width: 800, height: 600 }, visibleCards: [w.k1, w.k2] });
  a.presence.setShare(w.board, 'region'); await a.presence.idle();
  await w.tickAll([a, b]);
  const row = () => others(b.presence.snapshot())[0];
  assert.equal(row().active, true);
  // a keeps publishing: stays active across many cadences
  for (let i = 0; i < 5; i++) { await w.tickAll([a, b]); assert.equal(row().active, true); }
  // a stops (window closed, crash, cable out). b keeps reading.
  const stoppedAt = w.clock.now;
  await w.tickAll([b]); await w.tickAll([b]); await w.tickAll([b]);
  assert.equal(w.clock.now - stoppedAt, 9000); assert.equal(row().active, true, 'within one cadence + one request timeout a slow publish is tolerated');
  await w.tickAll([b]);
  assert.equal(w.clock.now - stoppedAt, 12_000); assert.deepEqual([row().active, !!row().viewport], [false, true], 'after 10 s: inactive (last rectangle still known)');
  for (let i = 0; i < 6; i++) await w.tickAll([b]);
  assert.equal(w.clock.now - stoppedAt, 30_000); assert.equal(row().active, false);
  await w.tickAll([b]);
  assert.equal(others(b.presence.snapshot()).length, 0, 'after 30 s the record is gone');
  assert.equal(w.hub.size(), 0, 'and deleted from the service memory');
  // idle is not the same as gone: a publishes but has not touched the Desk for a minute
  a.desk.lastInputAgeMs = 61_000; await w.tickAll([a, b]); await w.tickAll([a, b]);
  assert.deepEqual([row().active, row().lastInputAgeMs >= 60_000], [false, true]);
  a.desk.lastInputAgeMs = 0; await w.tickAll([a, b]); await w.tickAll([a, b]);
  assert.equal(row().active, true);
  // b loses the link: b's own copy ages by b's clock, without any new answer
  b.desk.link = false; const lostAt = w.clock.now;
  await w.tickAll([a, b]); await w.tickAll([a, b]); await w.tickAll([a, b]);
  assert.equal(row().active, true);
  await w.tickAll([a, b]);
  assert.ok(w.clock.now - lostAt > PRESENCE.staleMs); assert.equal(row().active, false, 'a reader without fresh answers does not keep showing others as active');
  for (let i = 0; i < 7; i++) await w.tickAll([a, b]);
  assert.equal(others(b.presence.snapshot()).length, 0);
  assert.deepEqual(b.presence.snapshot().map((r) => r.self), [true], 'the own row never depends on the network');
  // no provider for the own row -> nothing at all (and no request)
  const sent = w.wire.length; const mute = createJointPresence({ send: () => assert.fail('no request without the own row'), self: () => null, boards: () => [{ id: w.board, offset: { x: 0, y: 0 }, region: null }] });
  assert.equal(await mute.tick(), 0); assert.deepEqual(mute.snapshot(), []); assert.equal(w.wire.length, sent);
  // a provider without an alias, or one that looks like a remote alias, is shown as 'self'
  for (const member of [undefined, '', 'm-' + '0'.repeat(16)]) assert.equal(createJointPresence({ send: async () => null, self: () => ({ member, active: true, viewport: { x: 0, y: 0, width: 1, height: 1 }, focusCard: null, lastInputAgeMs: 0 }), boards: () => [] }).snapshot()[0].member, 'self');
});

test('membership is checked on every read: a member who leaves or is excluded disappears at once and can read nothing', async (t) => {
  const w = await world(t);
  const view = { x: 0, y: 0, width: 800, height: 600 };
  const pub = (who, share = 'region') => w.raw(who, share === 'off' ? { board: w.board, share } : { board: w.board, share, inputAgeMs: 0, ...(share === 'region' ? { viewport: view } : {}) });
  const step = () => { w.clock.now += PRESENCE_LIMITS.minIntervalMs; };
  step(); await pub('a'); await pub('b'); await pub('c');
  step(); assert.equal((await pub('a')).body.members.length, 2);
  const aliasC = (await (step(), pub('c'))).body.self;
  w.act('c', 'leave', { board: w.board });
  step(); assert.equal((await pub('a')).body.members.some((m) => m.member === aliasC), false, 'gone at the next read, not after the expiry');
  assert.equal((await pub('c')).status, 404);
  assert.equal(w.hub.size(), 2);
  // c is invited again: a new seat epoch. Nothing of the old seat comes back until c publishes again.
  w.act('a', 'inviteBoard', { board: w.board, to: 'c' }); w.act('c', 'accept', { invite: w.real.view('c').invites[0].id });
  step(); assert.equal((await pub('a')).body.members.length, 1);
  step(); assert.equal((await pub('c', 'active')).status, 200);
  step(); assert.equal((await pub('a')).body.members.length, 2);
  w.act('a', 'exclude', { board: w.board, to: 'c' });
  step(); assert.equal((await pub('b')).body.members.length, 1);
  assert.equal((await pub('c', 'off')).status, 404);
});

test('presence never writes the shared ledger, never persists, and reads this Desk without changing it', async (t) => {
  const w = await world(t);
  const members = ['a', 'b', 'c'];
  const before = { file: sha(w.file), views: members.map((p) => JSON.stringify(w.real.view(p))), writes: { ...w.writes } };
  const a = await w.person('a', { offset: { x: 1000, y: 500 }, viewport: { x: 1200, y: 700, width: 800, height: 600 }, visibleCards: [w.k1, w.k2] });
  const b = await w.person('b', { offset: { x: -300, y: 200 }, viewport: { x: 0, y: 400, width: 1280, height: 720 }, visibleCards: [w.k1, w.k2] });
  const c = await w.person('c', { offset: { x: 0, y: 0 }, viewport: { x: 40, y: 80, width: 1600, height: 880 }, visibleCards: [w.k2] });
  for (const p of [a, b, c]) { p.presence.setShare(w.board, 'region'); await p.presence.idle(); }
  const desks = [a, b, c].map((p) => JSON.stringify(p.desk));
  for (let i = 0; i < 12; i++) { a.desk.viewport.x += 40; a.desk.focusCard = a.alias(i % 2 ? w.k1 : w.k2); await w.tickAll([a, b, c]); }
  assert.equal(w.hub.size(), 3); assert.equal(others(c.presence.snapshot()).length, 2);
  const aliases = others(c.presence.snapshot()).map((r) => r.member);
  // the authority's database and every member's view are byte-for-byte what they were
  assert.equal(sha(w.file), before.file, 'the SQLite file did not change');
  assert.deepEqual(members.map((p) => JSON.stringify(w.real.view(p))), before.views, 'card positions, layout versions, grants and replies are untouched');
  assert.deepEqual(w.writes, before.writes, 'no write path of the authority was called');
  const db = new DatabaseSync(w.file, { readOnly: true });
  t.after(() => { try { db.close(); } catch {} });
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE lower(name) LIKE '%presence%'").get().n, 0);
  const dump = fs.readFileSync(w.file).toString('latin1');
  for (const mark of [...aliases, 'viewport', 'inputAgeMs', 'focusCard']) assert.equal(dump.includes(mark), false, 'not in the database: ' + mark);
  assert.deepEqual(fs.readdirSync(w.dir).filter((f) => !f.startsWith('joint.sqlite')), [], 'no other file was created');
  // the Desk inputs were only read (b and c did not move anything; a moved its own camera in this test)
  assert.deepEqual([b, c].map((p) => JSON.stringify(p.desk)), desks.slice(1));
  assert.deepEqual([a, b, c].map((p) => p.layoutWrites.length), [1, 1, 1], 'the only thing ever reported back to the host is the own sharing setting');
  // a restarted service (new process memory) knows nobody; aliases are not stable across restarts
  const hub2 = createHub({ access: w.store.presenceAccess, now: () => w.clock.now });
  const again = hub2.exchange('a', { board: w.board, share: 'off' });
  assert.deepEqual(again.members, []); assert.equal(hub2.size(), 0);
  hub2.exchange('b', { board: w.board, share: 'active', inputAgeMs: 0 });
  w.clock.now += 1000;
  assert.equal(aliases.includes(hub2.exchange('a', { board: w.board, share: 'off' }).members[0].member), false);
  // the hub has nothing but the read-only check
  assert.throws(() => createHub({}), /read-only access check/);
  assert.deepEqual(Object.keys(w.hub), ['exchange', 'size', 'clear']);
  assert.equal(w.real.presenceAccess('e', w.board), null); assert.equal(w.real.presenceAccess('d', w.board), null);
  assert.deepEqual(w.real.presenceAccess('c', w.board, [w.k1, w.k2, 'x', randomUUID()]).visible, [w.k2]);
  assert.equal(sha(w.file), before.file);
});

test('the default loopback service carries the route; a person in two Boards has unrelated aliases; projections map to presence inputs read-only', async (t) => {
  const w = await world(t, { defaultServer: true });
  // second Board with the same two founders
  const form = w.act('a', 'propose', { to: 'b', title: BOARD_TITLE + ' 2' }).sent[0];
  const board2 = w.act('b', 'accept', { invite: form.id }).boards[1].id;
  const pub = (who, board) => w.raw(who, { board, share: 'active', inputAgeMs: 0 });
  assert.equal((await pub('b', w.board)).status, 200); assert.equal((await pub('b', board2)).status, 200);
  await new Promise((r) => setTimeout(r, PRESENCE_LIMITS.minIntervalMs + 50)); // this server runs on the real clock
  const one = (await pub('a', w.board)).body, two = (await pub('a', board2)).body;
  assert.equal(one.members.length, 1); assert.equal(two.members.length, 1);
  assert.notEqual(one.members[0].member, two.members[0].member, 'the same person cannot be matched across Boards by alias');
  assert.notEqual(one.self, two.self);
  // projections of this Desk -> boards(), alias maps. Frozen inputs prove nothing is written.
  const freeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
  const nodes = { v1: { isConnected: true, g: { x: 1100, y: 600, width: 342, height: 228 } }, v2: { isConnected: true, g: { x: 1500, y: 900, width: 342, height: 228 } }, v3: { isConnected: false, g: { x: 9000, y: 9000, width: 10, height: 10 } } };
  const projections = freeze([
    { boardId: 'local-1', jointAccess: 'epoch-1', offset: { x: 1000, y: 500 }, members: [{ sourceId: w.k1, viewId: 'v1' }, { sourceId: w.k2, viewId: 'v2' }, { sourceId: randomUUID(), viewId: 'v3' }], idMap: { [w.k1]: 'v1', [w.k2]: 'v2' } },
    { boardId: 'local-stale', jointAccess: 'old-epoch', offset: { x: 0, y: 0 }, members: [], idMap: {} },
    { boardId: 'local-unknown', jointAccess: 'x', offset: { x: 0, y: 0 }, members: [], idMap: {} },
  ]);
  const boards = { 'local-1': { id: w.board, epoch: 'epoch-1' }, 'local-stale': { id: board2, epoch: 'new-epoch' } };
  const placed = projectionPresence({ projections: () => projections, boardOf: (p) => boards[p.boardId] || null, node: (id) => nodes[id] || null, geometry: (n) => n.g });
  assert.deepEqual(placed.boards(), [{ id: w.board, offset: { x: 1000, y: 500 }, region: { x: 1100, y: 600, width: 742, height: 528 } }], 'only a Board whose seat epoch still matches; region = the mounted cards');
  assert.equal(placed.cardAlias(w.board, w.k1), 'v1'); assert.equal(placed.cardAlias(w.board, 'constructor'), null); assert.equal(placed.cardAlias(board2, w.k1), null);
  assert.deepEqual(placed.cardId('v2'), { board: w.board, card: w.k2 }); assert.equal(placed.cardId('nope'), null);
});
