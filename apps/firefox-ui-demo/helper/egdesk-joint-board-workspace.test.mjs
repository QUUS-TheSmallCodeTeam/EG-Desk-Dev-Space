import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createJointStore } from './egdesk-joint-board-store.mjs';
import { startJointServer } from './egdesk-joint-board-server.mjs';
import { checkedView, createJointClient } from '../overlay/resources/EGDeskJointBoardClient.sys.mjs';

function workerFixture({ delayed = false, fail = false, cooperative = false } = {}) {
  const calls = [];
  return {
    calls,
    catalog: ['shipment', 'inspection'],
    async step(input, { signal }) {
      const reply = { type: input.type, state: input.to };
      const gate = Promise.withResolvers();
      if (cooperative) signal.addEventListener('abort', () => gate.reject(signal.reason), { once: true });
      calls.push({ input, signal, finish: () => gate.resolve(reply) });
      if (fail) throw Error('fixture-worker-offline');
      return delayed ? gate.promise : reply;
    },
  };
}

function workspace(t, { worker = workerFixture(), disk = false } = {}) {
  const dir = disk ? mkdtempSync(join(tmpdir(), 'joint-workspace-test-')) : null;
  const filename = disk ? join(dir, 'joint.sqlite') : ':memory:';
  let store = createJointStore(filename, { teamApps: worker });
  t.after(() => {
    store.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });
  const keys = {};
  for (const p of ['a', 'b', 'c', 'd', 'e']) keys[p] = store.issueAccount(p, p + ' label');
  const act = (p, action, fields = {}) => store.mutate(p, { request: randomUUID(), action, ...fields });
  const accept = (p) => {
    const invites = store.view(p).invites;
    assert.equal(invites.length, 1);
    return act(p, 'accept', { invite: invites[0].id });
  };
  act('a', 'propose', { to: 'b', title: 'Authority QA board' });
  const board = accept('b').boards[0].id;
  for (const to of ['c', 'd']) {
    act('a', 'inviteBoard', { board, to });
    accept(to);
  }
  const raw = (p) => store.view(p);
  const boardView = (p) => checkedView(raw(p)).boards.find((b) => b.id === board);
  const card = (p, id) => boardView(p)?.cards.find((c) => c.id === id);
  const add = (p, title) => act(p, 'addCard', { board, title, body: title + ' body', kind: 'note' }).boards[0].cards.at(-1);
  const app = (type = 'shipment') => act('a', 'addApp', { board, type, ref: 'Private ref 42' }).boards[0].cards.at(-1);
  const share = (p, target, to, scope = 'board') => {
    act(p, 'share', { card: target.id, version: card(p, target.id).version, to, scope });
    if (scope === 'single') accept(to);
    return card(p, target.id).grants.find((g) => g.person === to).id;
  };
  const permission = (target, grant, allow) => act('a', 'appPermission', {
    card: target.id, version: card('a', target.id).version, grant, allow,
  });
  const step = (c, to, fields = {}) => ({
    action: 'appStep', request: randomUUID(), card: c.id, version: c.version,
    access: c.access, editStamp: c.app.editStamp, appRev: c.app.rev, to, ...fields,
  });
  return {
    act, raw, boardView, card, add, app, share, permission, step, keys, board, worker, filename,
    get store() { return store; },
    restart(teamApps = worker) {
      assert.ok(disk);
      store.close();
      store = createJointStore(filename, { teamApps });
    },
  };
}

const unavailable = { status: 404, code: 'unavailable' };
const changed = { status: 409, code: 'changed' };
const interrupted = { status: 409, code: 'app-interrupted' };
const busy = { status: 409, code: 'app-busy' };
const conflict = { status: 409, code: 'request-conflict' };
const appUnavailable = { status: 503, code: 'app-unavailable' };
const link = (card, parent, fields = {}) => ({ card: card.id, version: card.version, parent: parent.id, kind: 'waits', ...fields });
const state = (c) => [c.app.state, c.app.rev, c.version];

test('card links require the source author, live same-board endpoints and both endpoints in each projection', (t) => {
  const w = workspace(t);
  const source = w.add('a', 'Source'), parent = w.add('b', 'Parent');
  w.act('a', 'place', { card: source.id, version: 1, layoutVersion: 0, x: 44, y: 44 });
  w.act('b', 'place', { card: parent.id, version: 1, layoutVersion: 0, x: 44, y: 44 });
  w.share('a', source, 'b');
  w.share('a', source, 'c');
  w.share('b', parent, 'd');
  w.share('a', source, 'e', 'single');
  w.share('b', parent, 'e', 'single');
  assert.throws(() => w.act('a', 'linkCard', link(source, parent)), unavailable);
  assert.throws(() => w.act('b', 'linkCard', link(source, parent)), unavailable);
  const foreignBoard = w.act('a', 'propose', { to: 'e', title: 'different board' }).sent[0];
  const otherBoard = w.act('e', 'accept', { invite: foreignBoard.id }).boards[0].id;
  const foreign = w.act('a', 'addCard', { board: otherBoard, title: 'Other', body: 'Other', kind: 'note' }).boards[1].cards[0];
  assert.throws(() => w.act('a', 'linkCard', link(source, foreign)), unavailable);
  w.share('b', parent, 'a');
  assert.deepEqual(w.card('a', source.id).position, w.card('a', parent.id).position);
  assert.deepEqual(w.boardView('a').links, [], 'overlap does not imply a relationship');
  w.act('a', 'linkCard', link(source, parent));
  const links = w.boardView('a').links;
  assert.equal(links.length, 1);
  assert.deepEqual(links[0], { child: source.id, parent: parent.id, kind: 'waits', stamp: links[0].stamp });
  assert.deepEqual(w.boardView('b').links, links);
  for (const [p, hidden] of [['c', parent.id], ['d', source.id]]) {
    assert.deepEqual(w.boardView(p).links, []);
    const view = JSON.stringify(w.raw(p));
    assert.ok(!view.includes(hidden) && !view.includes(links[0].stamp));
  }
  const single = w.raw('e');
  assert.equal(single.singles.length, 2);
  assert.ok(!JSON.stringify(single).includes(links[0].stamp));
  for (const c of single.singles) for (const key of ['position', 'board', 'links', 'parent', 'child', 'layoutVersion']) {
    assert.ok(!Object.hasOwn(c, key), `${key} leaked`);
  }
  w.share('b', parent, 'c');
  assert.deepEqual(w.boardView('c').links, links);
  w.act('b', 'removeCard', { card: parent.id, version: parent.version });
  assert.deepEqual(w.boardView('c').links, []);
  assert.throws(() => w.act('a', 'linkCard', link(source, parent)), unavailable);
  assert.deepEqual(w.raw('e').singles.map((c) => c.id), [source.id]);
});

test('revoking source author parent read authority retires the link even on regrant; prior is optimistic', (t) => {
  const w = workspace(t);
  const source = w.add('a', 'Source'), parent = w.add('b', 'Parent');
  w.share('a', source, 'b');
  const firstGrant = w.share('b', parent, 'a');
  const payload = link(source, parent, { request: randomUUID() });
  w.act('a', 'linkCard', payload);
  const old = w.boardView('a').links[0].stamp;
  w.act('a', 'linkCard', payload);
  assert.equal(w.boardView('a').links[0].stamp, old);
  assert.throws(() => w.act('a', 'linkCard', { ...payload, kind: 'refers' }), conflict);
  assert.throws(() => w.act('a', 'linkCard', link(source, parent, { kind: 'refers' })), changed);
  w.act('b', 'revoke', { card: parent.id, grant: firstGrant });
  assert.equal(w.boardView('b').cards.length, 2);
  assert.deepEqual(w.boardView('b').links, [], 'even another viewer with both endpoints loses the invalid link');
  const newGrant = w.share('b', parent, 'a');
  assert.notEqual(newGrant, firstGrant);
  assert.deepEqual(w.boardView('a').links, []);
  w.act('a', 'linkCard', payload);
  assert.deepEqual(w.boardView('a').links, [], 'successful replay must not resurrect a revoked relationship');
  assert.throws(() => w.act('a', 'linkCard', link(source, parent, { prior: old })), changed);
  w.act('a', 'linkCard', link(source, parent, { prior: null, kind: 'refers' }));
  const fresh = w.boardView('a').links[0].stamp;
  assert.notEqual(fresh, old);
  const unlink = { card: source.id, version: source.version };
  assert.throws(() => w.act('a', 'unlinkCard', { ...unlink, prior: old }), changed);
  assert.throws(() => w.act('b', 'unlinkCard', { ...unlink, prior: fresh }), unavailable);
  w.act('a', 'unlinkCard', { ...unlink, prior: fresh });
  assert.deepEqual(w.boardView('a').links, []);
});

test('waits rejects a multi-hop cycle without changing state; checked views reject dangling links', (t) => {
  const w = workspace(t);
  const x = w.add('a', 'X'), y = w.add('a', 'Y'), z = w.add('a', 'Z');
  w.act('a', 'linkCard', link(x, y));
  w.act('a', 'linkCard', link(y, z));
  const before = w.raw('a');
  assert.throws(() => w.act('a', 'linkCard', link(z, x)), { status: 409, code: 'cycle' });
  assert.deepEqual(w.raw('a'), before);
  const invalid = structuredClone(before);
  invalid.boards[0].cards = invalid.boards[0].cards.filter((c) => c.id !== y.id);
  assert.throws(() => checkedView(invalid), /invalid-response/);
});

test('typed grants separate board read, edit and standalone read; generic edit changes nothing', async (t) => {
  const w = workspace(t);
  const item = w.app('inspection');
  const boardGrant = w.share('a', item, 'b');
  const singleGrant = w.share('a', item, 'e', 'single');
  const single = w.raw('e').singles[0];
  assert.deepEqual(state(item), ['waiting', 1, 1]);
  const before = ['a', 'b', 'e'].map(w.raw);
  for (const [p, error] of [['a', { status: 403, code: 'app-fields' }], ['b', unavailable]]) {
    assert.throws(() => w.act(p, 'editCard', { card: item.id, version: 1, title: 'new', body: 'new' }), error);
  }
  assert.deepEqual(['a', 'b', 'e'].map(w.raw), before);
  assert.equal(w.card('b', item.id).app.mayEdit, false);
  assert.ok(!Object.hasOwn(w.card('b', item.id).app, 'editStamp'));
  assert.equal(single.app.mayEdit, false);
  assert.ok(!Object.hasOwn(single.app, 'editStamp'));
  assert.throws(() => w.permission(item, singleGrant, true), unavailable);
  assert.throws(() => w.act('b', 'appPermission', { card: item.id, version: 1, grant: boardGrant, allow: true }), unavailable);
  assert.throws(() => w.permission(item, boardGrant, 'true'), { status: 400, code: 'invalid-role' });
  await assert.rejects(w.store.stepApp('e', w.step(single, 'hold', { editStamp: item.app.editStamp })), unavailable);
  await assert.rejects(w.store.stepApp('b', w.step(w.card('b', item.id), 'hold')), unavailable);
  w.permission(item, boardGrant, true);
  const editor = w.card('b', item.id);
  assert.equal(editor.app.mayEdit, true);
  assert.equal(editor.access, boardGrant);
  await assert.rejects(w.store.stepApp('b', w.step(editor, 'picked')), { status: 400, code: 'invalid-transition' });
  await assert.rejects(w.store.stepApp('b', w.step(editor, 'hold', { access: singleGrant })), unavailable);
  w.permission(item, boardGrant, false);
  assert.equal(w.card('b', item.id).access, boardGrant);
  assert.equal(w.card('b', item.id).app.mayEdit, false);
  await assert.rejects(w.store.stepApp('b', w.step(editor, 'hold')), unavailable);
  w.permission(item, boardGrant, true);
  const editor2 = w.card('b', item.id);
  assert.notEqual(editor2.app.editStamp, editor.app.editStamp);
  await assert.rejects(w.store.stepApp('b', w.step(editor, 'hold')), unavailable);
  assert.equal(w.worker.calls.length, 0);
  await w.store.stepApp('b', w.step(editor2, 'hold'));
  assert.deepEqual(state(w.card('a', item.id)), ['hold', 2, 2]);
  assert.deepEqual(state(w.raw('e').singles[0]), ['hold', 2, 2]);
  assert.equal(w.raw('e').singles[0].app.mayEdit, false);
  const stale = w.step(w.card('b', item.id), 'pass');
  w.act('a', 'revoke', { card: item.id, grant: boardGrant });
  assert.equal(w.card('b', item.id), undefined);
  const nextGrant = w.share('a', item, 'b');
  assert.notEqual(nextGrant, boardGrant);
  assert.equal(w.card('b', item.id).app.mayEdit, false);
  w.permission(item, nextGrant, true);
  await assert.rejects(w.store.stepApp('b', stale), unavailable);
  assert.equal(w.worker.calls.length, 1);
});

test('typed step is one-flight, idempotent and rejects conflicting or stale requests', async (t) => {
  const w = workspace(t, { worker: workerFixture({ delayed: true }) });
  const item = w.app();
  const payload = w.step(item, 'picked');
  const inFlight = w.store.stepApp('a', payload);
  await assert.rejects(w.store.stepApp('a', payload), busy);
  await assert.rejects(w.store.stepApp('a', w.step(item, 'picked')), busy);
  await assert.rejects(w.store.stepApp('a', { ...payload, to: 'delivered' }), conflict);
  assert.throws(() => w.act('a', 'removeCard', { request: payload.request, card: item.id, version: 1 }), conflict);
  assert.deepEqual(w.worker.calls.map(({ input }) => input), [{ type: 'shipment', from: 'ready', to: 'picked' }]);
  assert.deepEqual(state(w.card('a', item.id)), ['ready', 1, 1]);
  w.worker.calls[0].finish();
  await inFlight;
  await w.store.stepApp('a', Object.fromEntries(Object.entries(payload).reverse()));
  await assert.rejects(w.store.stepApp('a', w.step(item, 'picked')), changed);
  assert.equal(w.worker.calls.length, 1);
  assert.deepEqual(state(w.card('a', item.id)), ['picked', 2, 2]);
});

for (const invalidation of ['revoke', 'downgrade', 'signal', 'worker-abort', 'remove', 'content revision']) {
  test(`late pure worker result cannot commit after ${invalidation}`, async (t) => {
    const worker = workerFixture({ delayed: true, cooperative: invalidation === 'worker-abort' });
    const w = workspace(t, { worker, disk: invalidation === 'content revision' });
    const item = w.app();
    const grant = w.share('a', item, 'b');
    w.permission(item, grant, true);
    const controller = new AbortController();
    const payload = w.step(w.card('b', item.id), 'picked');
    const pending = w.store.stepApp('b', payload, { signal: controller.signal });
    assert.equal(worker.calls.length, 1);
    const call = worker.calls[0];
    let expected = interrupted;
    switch (invalidation) {
      case 'revoke':
        w.act('a', 'revoke', { card: item.id, grant });
        w.permission(item, w.share('a', item, 'b'), true);
        break;
      case 'downgrade':
        w.permission(item, grant, false);
        w.permission(item, grant, true);
        break;
      case 'signal':
      case 'worker-abort':
        controller.abort();
        break;
      case 'remove':
        w.act('a', 'removeCard', { card: item.id, version: 1 });
        break;
      case 'content revision': {
        // App writes are single-flight and generic edits are denied. Inject a content-only
        // revision through a second fixture connection to exercise the commit-time fence.
        const db = new DatabaseSync(w.filename);
        try {
          db.prepare('UPDATE cards SET rev=rev+1 WHERE id=?').run(item.id);
        } finally {
          db.close();
        }
        expected = changed;
        break;
      }
    }
    assert.equal(call.signal.aborted, invalidation !== 'content revision');
    const rejected = assert.rejects(pending, expected);
    if (invalidation !== 'worker-abort') call.finish();
    await rejected;
    await assert.rejects(w.store.stepApp('b', payload), interrupted);
    if (invalidation === 'remove') assert.equal(w.card('a', item.id), undefined);
    else assert.deepEqual(state(w.card('a', item.id)), ['ready', 1, invalidation === 'content revision' ? 2 : 1]);
    assert.equal(worker.calls.length, 1);
  });
}

test('unavailable worker does not advance revisions or retry a request; absent worker is read-only', async (t) => {
  const w = workspace(t, { disk: true, worker: workerFixture({ fail: true }) });
  const item = w.app();
  const before = w.raw('a');
  const payload = w.step(item, 'picked');
  await assert.rejects(w.store.stepApp('a', payload), appUnavailable);
  await assert.rejects(w.store.stepApp('a', payload), interrupted);
  assert.deepEqual(w.raw('a'), before);
  assert.equal(w.worker.calls.length, 1);
  w.restart(null);
  assert.deepEqual(w.raw('a').appCatalog, []);
  assert.deepEqual(state(w.card('a', item.id)), ['ready', 1, 1]);
  assert.equal(w.card('a', item.id).app.available, false);
  assert.equal(w.card('a', item.id).app.mayEdit, false);
  await assert.rejects(w.store.stepApp('a', w.step(item, 'picked')), unavailable);
  assert.equal(w.worker.calls.length, 1);
});

test('restart interrupts pending app runs, preserves completed replay, and persists no bearer plaintext', async (t) => {
  const worker = workerFixture({ delayed: true });
  const w = workspace(t, { disk: true, worker });
  const item = w.app();
  const first = w.step(item, 'picked');
  const start = w.store.stepApp('a', first);
  worker.calls[0].finish();
  await start;
  const last = w.step(w.card('a', item.id), 'delivered');
  const pending = w.store.stepApp('a', last);
  const rejected = assert.rejects(pending, interrupted);
  const instance = w.raw('a').instance;
  w.restart();
  assert.equal(worker.calls[1].signal.aborted, true);
  worker.calls[1].finish();
  await rejected;
  assert.equal(w.raw('a').instance, instance);
  assert.equal(w.store.authentic(w.keys.a), 'a');
  assert.ok(!readFileSync(w.filename).includes(Buffer.from(w.keys.a)));
  await assert.rejects(w.store.stepApp('a', last), interrupted);
  await w.store.stepApp('a', first);
  assert.equal(worker.calls.length, 2);
  assert.deepEqual(state(w.card('a', item.id)), ['picked', 2, 2]);
});

test('loopback protocol performs a single typed POST on lost response and sends no ambient credentials', async (t) => {
  const w = workspace(t);
  const item = w.app();
  const server = await startJointServer(w.store, 0);
  t.after(() => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve())));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const calls = [], errors = [];
  const client = createJointClient({
    uuid: randomUUID, timeoutSignal: () => AbortSignal.timeout(2000), apply() {},
    unavailable: (reason) => errors.push(reason),
    async request(url, options) {
      calls.push({ url, options });
      const res = await fetch(url, options);
      if (options.method === 'POST') {
        assert.equal(res.status, 200);
        await res.text(); // Authority committed, but the client never received an actionable result.
        throw Error('fixture-response-lost');
      }
      return res;
    },
  });
  await client.connect(origin, w.keys.a);
  let { request, ...input } = w.step(item, 'picked');
  await assert.rejects(client.act(input), /unconfirmed/);
  assert.equal(client.view, null);
  assert.deepEqual(errors, ['unconfirmed']);
  assert.deepEqual(calls.map(({ options }) => options.method), ['GET', 'POST']);
  for (const { url, options } of calls) {
    assert.equal(new URL(url).origin, origin);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.deepEqual(Object.keys(options.headers).sort(), options.method === 'POST' ? ['Authorization', 'Content-Type'] : ['Authorization']);
    assert.ok(options.headers.Authorization === 'Bearer ' + w.keys.a);
    assert.ok(!(options.body ?? '').includes(w.keys.a));
  }
  assert.deepEqual(w.worker.calls.map(({ input }) => input), [{ type: 'shipment', from: 'ready', to: 'picked' }]);
  const refreshed = await client.refresh();
  assert.deepEqual(state(refreshed.boards[0].cards[0]), ['picked', 2, 2]);
  assert.deepEqual(calls.map(({ options }) => options.method), ['GET', 'POST', 'GET']);
});

test('view and app editor are not pixel-release grants; re-grant cannot revive an old photograph',t=>{const w=workspace(t);const c=w.app(),g=w.share('a',c,'c');w.permission(c,g,true);assert.equal(w.card('c',c.id).layoutPhotoGrant,undefined);const permit=(by,allow)=>w.act(by,'photoPermission',{card:c.id,version:c.version,grant:g,allow});assert.throws(()=>permit('c',true));permit('a',true);const first=w.card('c',c.id).layoutPhotoGrant;assert.ok(first);permit('a',false);assert.equal(w.card('c',c.id).layoutPhotoGrant,undefined);permit('a',true);assert.notEqual(w.card('c',c.id).layoutPhotoGrant,first);w.act('a','revoke',{card:c.id,grant:g});w.share('a',c,'c');assert.equal(w.card('c',c.id).layoutPhotoGrant,undefined);const single=w.share('a',c,'e','single');assert.throws(()=>w.act('a','photoPermission',{card:c.id,version:c.version,grant:single,allow:true}));assert.equal(w.raw('e').singles[0].layoutPhotoGrant,undefined);});
