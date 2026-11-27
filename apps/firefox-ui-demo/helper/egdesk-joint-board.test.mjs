import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createJointStore } from './egdesk-joint-board-store.mjs';
import { startJointServer, startJointTlsServer } from './egdesk-joint-board-server.mjs';
import {
  createJointClient,
  checkedView,
  jointSnapshot,
  localBoardId,
  scrubJointSession,
  serviceOrigin,
} from '../overlay/resources/EGDeskJointBoardClient.sys.mjs';
const add = (s, p, o, r = randomUUID()) => s.mutate(p, { ...o, request: r });
function world(t) {
  let time = 86400000;
  const s = createJointStore(':memory:', { now: () => time });
  t.after(() => s.close());
  const keys = {};
  for (const p of ['a', 'b', 'c', 'd']) keys[p] = s.issueAccount(p, p + ' label');
  const act = (p, k, o = {}) => add(s, p, { action: k, ...o });
  const title = 'restricted board',
    privateBody = 'private margin 17';
  const form = act('a', 'propose', { to: 'b', title }).sent[0];
  const b = act('b', 'accept', { invite: form.id }).boards[0];
  const card = act('a', 'addCard', { board: b.id, title: 'SH-42', body: 'available for pickup', kind: 'task' })
    .boards[0].cards[0];
  act('a', 'addCard', { board: b.id, title: privateBody, body: privateBody, kind: 'note' });
  return {
    s,
    keys,
    act,
    b,
    card,
    title,
    privateBody,
    form,
    advance: (n) => {
      time += n;
    },
    single() {
      act('a', 'share', { card: card.id, version: 1, to: 'c', scope: 'single' });
      const i = s.view('c').invites[0];
      return act('c', 'accept', { invite: i.id }).singles[0];
    },
  };
}
test('issuance, rotation and service restart persist authority, not bearer plaintext', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-owned-joint-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const name = path.join(dir, 'joint.sqlite');
  let s = createJointStore(name);
  const k = s.issueAccount('people', '사람');
  const instance = s.view('people').instance;
  assert.equal(s.authentic(k), 'people');
  assert.equal(s.authentic('a provider credential'), null);
  s.close();
  assert.ok(!fs.readFileSync(name).includes(Buffer.from(k)));
  s = createJointStore(name);
  t.after(() => s.close());
  assert.equal(s.view('people').instance, instance);
  assert.equal(s.authentic(k), 'people');
  const next = s.issueAccount('people', '사람', { rotate: true });
  assert.equal(s.authentic(k), null);
  assert.equal(s.authentic(next), 'people');
  assert.throws(() => s.issueAccount('people', '사람'), /account-exists/);
});
test('repeat acceptance and reordered idempotency key replay create no duplicate Board or card', (t) => {
  const { s, act, b, form } = world(t);
  assert.equal(act('b', 'accept', { invite: form.id }).boards.length, 1);
  const req = randomUUID();
  const input = { action: 'addCard', board: b.id, title: 'new', body: 'text', kind: 'note' };
  add(s, 'a', input, req);
  const v = s.mutate('a', Object.fromEntries(Object.entries({ ...input, request: req }).reverse()));
  assert.equal(v.boards[0].cards.filter((c) => c.title === 'new').length, 1);
  assert.throws(() => add(s, 'a', { ...input, title: 'different' }, req), /request-conflict/);
});
test('expired, declined and wrong recipient proposals never create a Board', (t) => {
  const { s, act, advance } = world(t);
  act('a', 'propose', { to: 'd', title: 'decline' });
  let i = s.view('d').invites[0];
  assert.throws(() => act('c', 'accept', { invite: i.id }), /unavailable/);
  act('d', 'decline', { invite: i.id });
  assert.throws(() => act('d', 'accept', { invite: i.id }), /invite-closed/);
  act('a', 'propose', { to: 'd', title: 'expire' });
  i = s.view('d').invites[0];
  advance(7 * 86400000);
  assert.equal(s.view('d').invites.length, 0);
  assert.throws(() => act('d', 'accept', { invite: i.id }), /invite-closed/);
  assert.deepEqual(s.view('d').boards, []);
});
test('membership is not read permission; single view has no parent, neighbours, coordinates, recipients or replies', (t) => {
  const { s, b, card, act, title, privateBody, single } = world(t);
  assert.equal(s.view('b').boards[0].cards.length, 0);
  act('a', 'place', { card: card.id, layoutVersion: 0, version: 1, x: 45, y: 76 });
  single();
  const v = checkedView(s.view('c'));
  assert.deepEqual(v.boards, []);
  for (const x of [title, b.id, privateBody]) assert.ok(!JSON.stringify(v).includes(x));
  assert.deepEqual(
    Object.keys(v.singles[0]).sort(),
    'access author body claimed id kind own replied scope title version'.split(' ').sort(),
  );
  assert.throws(() => act('c', 'addCard', { board: b.id, title: 'a', body: 'b', kind: 'task' }), /unavailable/);
});
test('pending standalone grant does not authorize a rewritten card; author must send a fresh offer', (t) => {
  const { s, act, card } = world(t);
  act('a', 'share', { card: card.id, version: 1, to: 'c', scope: 'single' });
  const before = s.view('c').invites[0];
  act('a', 'editCard', { card: card.id, version: 1, title: '새 원문', body: '바뀐 내용' });
  assert.deepEqual(s.view('c').invites, []);
  assert.throws(() => act('c', 'accept', { invite: before.id }), /invite-closed/);
  act('a', 'share', { card: card.id, version: 2, to: 'c', scope: 'single' });
  const after = s.view('c').invites[0];
  assert.notEqual(after.id, before.id);
  assert.equal(act('c', 'accept', { invite: after.id }).singles[0].version, 2);
});
test('a pending single offer is not a back door around revocation of a subsequent Board grant', (t) => {
  const { s, act, card } = world(t);
  act('a', 'share', { card: card.id, version: 1, to: 'b', scope: 'single' });
  const i = s.view('b').invites[0].id;
  const v = act('a', 'share', { card: card.id, version: 1, to: 'b', scope: 'board' });
  act('a', 'revoke', { card: card.id, grant: v.boards[0].cards[0].grants[0].id });
  assert.throws(() => act('b', 'accept', { invite: i }), /invite-closed/);
  assert.equal(s.view('b').boards[0].cards.length, 0);
});
test('claim, explicit addressed reply and permissions are separate; a placement does not reopen a sent reply', (t) => {
  const { s, act, card, single } = world(t);
  const c = single();
  const send = { grant: c.access, version: 1, to: 'a', body: '명시 회신' };
  assert.throws(() => act('c', 'reply', send), /not-claimed/);
  act('c', 'claim', send);
  assert.deepEqual(s.view('a').boards[0].cards[0].replies, []);
  assert.throws(() => act('c', 'reply', { ...send, to: 'b' }), /not-claimed/);
  act('c', 'reply', send);
  assert.equal(s.view('a').boards[0].cards[0].replies.length, 1);
  act('a', 'place', { card: card.id, version: 1, layoutVersion: 0, x: 35, y: 42 });
  assert.equal(s.view('c').singles[0].replied, true);
  assert.throws(() => act('a', 'place', { card: card.id, version: 1, layoutVersion: 0, x: 38, y: 47 }), /changed/);
  assert.throws(() => act('c', 'reply', send), /already-replied/);
  assert.ok(!JSON.stringify(s.view('b')).includes('명시 회신'));
  act('a', 'revoke', { card: card.id, grant: c.access });
  assert.throws(() => act('c', 'reply', send), /unavailable/);
  assert.equal(s.view('a').boards[0].cards[0].replies.length, 1);
});
test('exclusion removes board grant and source withdrawal also ends independently issued item reads', (t) => {
  const { s, act, b, card, single } = world(t);
  const c = single();
  act('a', 'inviteBoard', { board: b.id, to: 'd' });
  act('d', 'accept', { invite: s.view('d').invites[0].id });
  act('a', 'share', { card: card.id, version: 1, to: 'd', scope: 'board' });
  const previous = s.view('d').boards[0].epoch;
  act('b', 'exclude', { board: b.id, to: 'd' });
  assert.deepEqual(s.view('d').boards, []);
  act('a', 'inviteBoard', { board: b.id, to: 'd' });
  act('d', 'accept', { invite: s.view('d').invites[0].id });
  const restored = s.view('d').boards[0];
  assert.notEqual(restored.epoch, previous);
  assert.equal(restored.cards.length, 0);
  act('a', 'leave', { board: b.id });
  assert.deepEqual(s.view('c').singles, []);
  assert.throws(() => act('c', 'claim', { grant: c.access, version: 1 }), /unavailable/);
  assert.throws(() => act('b', 'leave', { board: b.id }), /last-founder/);
});
test('scrub isolates protected projection while preserving a valid local Desk for next startup', (t) => {
  const { s } = world(t),
    v = checkedView(s.view('a')),
    b = v.boards[0],
    id = localBoardId(v.instance, b.id),
    snap = jointSnapshot(v.instance, b);
  assert.ok(!JSON.stringify(snap.cards).includes('SH-42'));
  assert.notEqual(snap.cards[0].geometry.x, snap.cards[1].geometry.x);
  for (const projections of [
    undefined,
    {
      activeProjectionId: 'q',
      projections: { q: { boardId: id, jointAccess: b.epoch, title: b.title, members: [{ viewId: 'q1' }] } },
    },
  ]) {
    const body = scrubJointSession(
      {
        agenda: { id, title: b.title, memberCardIds: ['q1', 'personal'] },
        desk: { activeAgendaId: id, activeCardId: 'q1', collapsedViewIds: ['q1'] },
        boardProjections: projections,
        cards: [
          { id: 'q1', type: 'joint-item' },
          { id: 'personal', type: 'memo' },
        ],
      },
      ['q1'],
    );
    assert.equal(body.agenda.id, 'agenda-default');
    assert.deepEqual(body.agenda.memberCardIds, ['personal']);
    assert.deepEqual(body.cards, [{ id: 'personal', type: 'memo' }]);
    assert.ok(!JSON.stringify(body).includes(b.title));
  }
});
test('canonical origins, verified service instance/person, omitted cookies, network uncertainty and one-shot write', async (t) => {
  const { s, keys } = world(t);
  for (const bad of [
    'http://example.test',
    'https://user:pass@example.test',
    'https://example.test/x',
    'https://example.test/?q=1',
  ])
    assert.throws(() => serviceOrigin(bad), /invalid-address/);
  const renders = [],
    log = [];
  let mode = 'normal';
  const api = createJointClient({
    uuid: randomUUID,
    timeoutSignal: () => AbortSignal.timeout(500),
    request: async (u, o) => {
      log.push([u, o]);
      if (mode === 'fail') throw Error('offline');
      return new Response(JSON.stringify(s.view(mode === 'switched' ? 'b' : 'a')));
    },
    apply: (v) => renders.push(v),
    unavailable: () => {},
  });
  await api.connect('http://127.0.0.1:47301', keys.a);
  mode = 'fail';
  await assert.rejects(api.act({ action: 'propose', to: 'b', title: 'x' }), /unconfirmed/);
  assert.equal(log.length, 2);
  assert.equal(log[1][1].credentials, 'omit');
  assert.equal(log[1][1].redirect, 'error');
  assert.equal(api.view, null);
  await assert.rejects(api.act({ action: 'claim' }), /disconnected/);
  mode = 'normal';
  await api.refresh();
  mode = 'switched';
  await assert.rejects(api.refresh(), /invalid-response/);
  assert.equal(api.connected, false);
  assert.equal(renders.at(-1), null);
});
test('HTTP accepts a service bearer, not cookies; TLS service never accepts an http origin', async (t) => {
  const { s, keys } = world(t);
  const server = await startJointServer(s, 0);
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = 'http://127.0.0.1:' + server.address().port + '/v1/joint/view';
  assert.equal((await fetch(url, { headers: { Cookie: 'session=unrelated' } })).status, 401);
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + keys.a } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal((await res.json()).self.id, 'a');
  assert.equal(
    (await fetch(url, { headers: { Authorization: 'Bearer ' + keys.a, Origin: 'https://other.test' } })).status,
    403,
  );
  assert.throws(() => startJointTlsServer(s, { origin: 'http://localhost:4000', bind: '127.0.0.1' }), /HTTPS/);
});
test('opt-in TLS endpoint serves an authorized view with a locally trusted ephemeral certificate', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const https = await import('node:https');
  const net = await import('node:net');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-owned-cert-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = path.join(dir, 'key.pem'),
    cert = path.join(dir, 'cert.pem'),
    config = path.join(dir, 'config');
  fs.writeFileSync(
    config,
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n',
  );
  try {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-keyout',
        key,
        '-out',
        cert,
        '-config',
        config,
      ],
      { stdio: 'ignore' },
    );
  } catch (e) {
    if (e.code === 'ENOENT') {
      t.skip('optional local openssl is absent');
      return;
    }
    throw e;
  }
  const guard = net.createServer();
  const port = await new Promise((yes, no) => {
    guard.once('error', no);
    guard.listen(0, '127.0.0.1', () => {
      const n = guard.address().port;
      guard.close(() => yes(n));
    });
  });
  const { s, keys } = world(t);
  const ca = fs.readFileSync(cert);
  const origin = 'https://127.0.0.1:' + port;
  const server = await startJointTlsServer(s, { origin, bind: '127.0.0.1', cert: ca, key: fs.readFileSync(key) });
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const got = await new Promise((yes, no) => {
    https
      .get(
        origin + '/v1/joint/view',
        { ca, headers: { Authorization: 'Bearer ' + keys.a }, agent: false },
        (res) => {
          let body = '';
          res.on('data', (b) => (body += b));
          res.on('end', () =>
            yes({ status: res.statusCode, view: JSON.parse(body), trusted: res.socket.authorized }),
          );
        },
      )
      .on('error', no);
  });
  assert.equal(got.status, 200);
  assert.equal(got.view.self.id, 'a');
  assert.equal(got.trusted, true);
});
