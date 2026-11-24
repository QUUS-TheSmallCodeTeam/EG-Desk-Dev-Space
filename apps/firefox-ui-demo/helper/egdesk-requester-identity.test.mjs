// Requester identity (L1 cycle 10): a Board member's request reaches the owner's Desk with WHO asked, as the member's presence alias,
// and the two consumers of presence see that member instead of the local person:
//   L1 the joint presence service (claim / resolve of an opaque request tag), the client module, the Desk's run requesters, the bridge registry
//   L4 the placement runtime (EGDeskWorkPlacement: scene, options, hard rules, attention) and its judge half on the conversation's heartbeat
//   L3 the audience rule and the pointer route inside the real chat runtime (mock engine, mock Decision model, virtual clock)
// Synthetic: the three people, their Desks, the request, the clocks, the Decision model, the engine. Loopback only; nothing leaves the machine.
// What is NOT product today and is said so in the report: no screen starts an owner Agent run from a member's request. The test calls the
// same hook (runRequesters.set) that such a trigger would call, with the requester the service vouched for.
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
import { createPresenceMirror, createPresenceMirrorHttpHandler, createRunRequesters, createRunRequesterHttpHandler, PRESENCE_MIRROR, RUN_REQUESTER } from './egdesk-presence-mirror.mjs';
import { createWorkPlacement, createWorkPlacementHttpHandler, WORK_PLACEMENT_LIMITS } from './egdesk-work-placement.mjs';
import { HEARTBEAT_LIMITS } from './egdesk-heartbeat.mjs';
import { pointerRoute } from './egdesk-conversation-flow.mjs';
import { world as heartbeatWorld } from './egdesk-heartbeat-flow.fixture.mjs';
import { createBoardAgentAskService } from './egdesk-board-agent-ask.mjs';
import { selectBoardAgentContext } from './egdesk-board-agent-context.mjs';
import { openDeskStore } from './egdesk-desk-store.mjs';
import { createJointClient } from '../overlay/resources/EGDeskJointBoardClient.sys.mjs';
import { createBoardAgentAsk } from '../overlay/resources/EGDeskBoardAgentAsk.sys.mjs';
import * as JP from '../overlay/resources/EGDeskJointPresence.sys.mjs';
import * as WP from '../overlay/resources/EGDeskWorkPlacement.sys.mjs';

const r = (x, y, width, height) => ({ x, y, width, height });
const hits = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
const gapTo = (a, b) => Math.hypot(Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width)), Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height)));
const sha = (text) => createHash('sha256').update(text).digest('hex');
const sha256Hex = async (text) => sha(text);
const ALIAS = /^m-[0-9a-f]{16}$/;
const S = HEARTBEAT_LIMITS;
const QUESTION = '금요일 방문자 주차는 어디에 하나요?';
const request = () => ({ kind: 'request', requestId: randomUUID(), requestDigest: sha('synthetic request ' + randomUUID()), question: QUESTION, recipient: '소유자', excerpt: '', expectedReply: 'short', askCode: 'egask1-synthetic-not-a-code' });

// ---------- the world: one loopback joint Board service, three seated people (a = the Board's owner side, b and c = members) ----------
async function world(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-requester-'));
  const clock = { now: 1_800_000_000_000 };
  const store = createJointStore(path.join(dir, 'joint.sqlite'), { now: () => clock.now });
  const keys = {};
  for (const p of ['a', 'b', 'c']) keys[p] = store.issueAccount(p, 'synthetic ' + p);
  const act = (p, action, o = {}) => store.mutate(p, { action, ...o, request: randomUUID() });
  const board = act('b', 'accept', { invite: act('a', 'propose', { to: 'b', title: 'synthetic board' }).sent[0].id }).boards[0].id;
  act('a', 'inviteBoard', { board, to: 'c' }); act('c', 'accept', { invite: store.view('c').invites[0].id });
  const hub = createHub({ access: store.presenceAccess, now: () => clock.now });
  const server = await new Promise((resolve) => { const h = http.createServer(jointHttp(store, { presence: hub })); h.listen(0, '127.0.0.1', () => resolve(h)); });
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(() => { server.closeAllConnections(); server.close(); try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });
  async function person(who, { offset, view }) {
    const desk = { offset, view, focus: null, inputAt: clock.now };
    const wire = [];
    const single = WP.createSingleUserPresence({ viewport: () => ({ ...desk.view }), focusCard: () => desk.focus, lastInputAt: () => desk.inputAt, now: () => clock.now });
    const client = createJointClient({ request: (url, init) => { if (String(url).endsWith('/v1/joint/presence')) wire.push(String(init.body)); return fetch(url, init); }, timeoutSignal: () => AbortSignal.timeout(7000), uuid: randomUUID, apply() {}, unavailable() {} });
    await client.connect(origin, keys[who]);
    const joint = JP.createJointPresence({ send: (body) => client.presence(body), now: () => clock.now, self: () => single.snapshot()[0] ?? null,
      boards: () => [{ id: board, offset: { ...desk.offset }, region: r(desk.offset.x - 400, desk.offset.y - 400, 6000, 4000) }] });
    const presence = JP.createDeskPresence({ single, joint: () => joint });
    // what the surface installs: the request side of requester identity, over this Desk's joint presence
    const requests = JP.createRequestRequesters({ joint: () => joint, sha256Hex });
    return { who, desk, single, joint, presence, requests, wire, touch: () => { desk.inputAt = clock.now; } };
  }
  const round = async (people, ms = JP.PRESENCE.publishMs) => { clock.now += ms; for (const p of people) { p.touch(); await p.joint.tick(); } };
  return { dir, clock, store, board, hub, act, person, round };
}
// The bridge's handlers, called with the same request/response objects the bridge passes (no socket).
function bridgeCalls(handlers) {
  return async (pathname, body, { headers = {} } = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req, { method: 'POST', url: pathname, headers: { host: '127.0.0.1:39218', origin: 'chrome://browser', 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' } });
    const res = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false, setHeader() {}, writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); this.writableEnded = true; } });
    for (const handler of handlers) if (await handler(req, res, new URL('http://127.0.0.1:39218' + pathname))) return { status: res.status, body: res.body };
    return { status: 0, body: null };
  };
}
// A Decisions client for the placement judge that answers its yes/no questions from the CONTENT it was sent (as in the placement suite, L1 c12):
// "same matter?" from the card quoted under each question, "does the result need the owner?" from the quoted result.
function placementJudge({ sameMatter = (card) => /주차/.test(card), ownerAction = (text) => /승인|정해 주세요/.test(text) } = {}) {
  const calls = [];
  return { calls, model: 'mock', async decide(req) {
    calls.push(JSON.stringify(req));
    const quoted = (name) => req.input.find((row) => row.content.startsWith(`Question ${name}:`))?.content ?? '';
    const answers = {};
    for (const q of req.questions) answers[q.name] = { type: 'predicate', probability: (q.name === 'owner_action' ? ownerAction(req.input.map((row) => row.content).join('\n')) : sameMatter(quoted(q.name))) ? 0.97 : 0.03 };
    return { answers, usage: { inputTokens: 9 } };
  } };
}
const OWNER_VIEW = r(0, 0, 1280, 800);            // region A: what the owner is looking at
const B_SEES = r(2900, 500, 1200, 800);           // B's camera on B's own Desk
const B_VIEW = r(2400, 200, 1200, 800);           // the same area on the OWNER's canvas (B's Board offset is 500,300)
const FILE = { kind: 'file', size: { width: 720, height: 520 } };
const POINTER = '오른쪽에 확인이 필요한 결과가 있어요. 편하실 때 확인해 주세요.';

// ================= 1. who asked: the service vouches, nobody types an alias =================
test('a request tag: claimed by the member who made the request, resolved by the Desk that received it; no alias is taken on anybody\'s word', async (t) => {
  const w = await world(t);
  const a = await w.person('a', { offset: { x: 0, y: 0 }, view: OWNER_VIEW });
  const b = await w.person('b', { offset: { x: 500, y: 300 }, view: B_SEES });
  const c = await w.person('c', { offset: { x: -900, y: 40 }, view: r(-800, 100, 1024, 768) });
  const review = request();
  const tag = await JP.requestTag(review, sha256Hex);
  assert.match(tag, /^[0-9a-f]{64}$/); assert.equal(await JP.requestTag({ ...review, kind: 'reply' }, sha256Hex), null);
  assert.notEqual(tag, await JP.requestTag({ ...review, requestDigest: sha('another') }, sha256Hex), 'another request has another tag');

  // B wrote the request file while sharing nothing: nothing is announced, nobody can be named.
  assert.equal(await b.requests.exported(review), true); assert.equal(await a.requests.inspected(review), true);
  await w.round([a, b, c]); await w.round([a, b, c]);
  assert.equal(w.hub.claimCount(), 0); assert.equal(a.requests.of(review), null, 'a member who shares no presence has no alias to hand out');
  assert.ok(b.wire.every((body) => !body.includes('claim')), 'with sharing off the tag does not leave B\'s Desk');

  // B turns presence sharing on: the Desk announces the request it made, the owner's Desk learns who.
  b.joint.setShare(w.board, 'active'); await b.joint.idle();
  await w.round([a, b, c]); await w.round([a, b, c]);
  const who = a.requests.of(review);
  assert.deepEqual(who, { board: w.board, alias: b.joint.aliasOn(w.board) }); assert.match(who.alias, ALIAS);
  assert.equal(a.joint.seated(w.board, who.alias), true); assert.equal(a.joint.seated(w.board, 'm-' + '0'.repeat(16)), false);

  // Content-free: only the hash went to the service. Not the question, the request id, the digest or the code.
  for (const body of [...a.wire, ...b.wire]) for (const secret of [QUESTION, review.requestId, review.requestDigest, review.askCode, '주차']) assert.ok(!body.includes(secret), secret);
  assert.ok(b.wire.some((body) => JSON.parse(body).claim?.[0] === tag)); assert.ok(a.wire.some((body) => JSON.parse(body).resolve?.[0] === tag));
  // A Desk that did not ask about a tag is not told anything, and its answers look exactly as before.
  w.clock.now += 1500;
  const plain = w.hub.exchange('c', { board: w.board, share: 'off' });
  assert.deepEqual(Object.keys(plain), ['version', 'board', 'self', 'share', 'staleMs', 'expireMs', 'members']);

  // C holds the same file (it was forwarded) and announces it too: the first claim by a still seated member stands.
  c.joint.setShare(w.board, 'active'); await c.joint.idle(); assert.equal(c.joint.claimRequest(tag), true);
  await w.round([a, b, c]); await w.round([a, b, c]);
  assert.equal(a.requests.of(review).alias, b.joint.aliasOn(w.board)); assert.notEqual(c.joint.aliasOn(w.board), b.joint.aliasOn(w.board));
  // The claimer does not resolve itself; a member who does not hold the tag cannot ask about it (64 hex of a hash it does not know).
  w.clock.now += 1500;
  assert.deepEqual(w.hub.exchange('b', { board: w.board, share: 'active', inputAgeMs: 0, resolve: [tag] }).resolved, []);
  // Malformed or oversized claims are refused whole; a person without a seat is refused by the seat check as before.
  w.clock.now += 1500;
  for (const bad of [{ claim: ['x'] }, { claim: [tag, tag] }, { claim: Array.from({ length: PRESENCE_LIMITS.maxTags + 1 }, (_, i) => sha('t' + i)) }, { resolve: 'all' }, { claim: [tag.toUpperCase()] }])
    assert.throws(() => w.hub.exchange('c', { board: w.board, share: 'active', inputAgeMs: 0, ...bad }), (e) => e.status === 400, JSON.stringify(bad).slice(0, 40));
  assert.throws(() => w.hub.exchange('c', { board: w.board, share: 'off', claim: [tag] }), (e) => e.status === 400, 'no claim without sharing');
  assert.throws(() => w.hub.exchange('nobody', { board: w.board, share: 'off', resolve: [tag] }), (e) => e.status === 403 || e.status === 404);

  // B turns sharing off: the claim goes with the record, at once. The owner's Desk stops naming B.
  b.joint.setShare(w.board, 'off'); await b.joint.idle();
  await w.round([a, c]);
  assert.equal(a.requests.of(review), null);
  // ... and C, who announced the same tag later, is NOT silently promoted for the Desk that already resolved: a new answer names C only
  // because C is now the only seated member claiming it. This is the limit of a shared file: whoever holds it can claim it (see report).
  await w.round([a, b, c]); await w.round([a, b, c]);
  assert.equal(a.requests.of(review)?.alias, c.joint.aliasOn(w.board));

  // C leaves the Board: the seat is gone, so is the claim and the name.
  w.act('c', 'leave', { board: w.board });
  await w.round([a, b]); await w.round([a, b]);
  assert.equal(a.requests.of(review), null); assert.equal(a.joint.seated(w.board, c.joint.aliasOn(w.board)), false);

  // A request file travels by hand: the owner may open it long after it was written. While B's Desk stays open it keeps announcing,
  // so an owner who opens the file an hour later still learns who (the owner's Desk asks again when its person opens the file).
  b.joint.setShare(w.board, 'active'); await b.joint.idle(); await w.round([a, b]); await w.round([a, b]);
  assert.equal(a.requests.of(review)?.alias, b.joint.aliasOn(w.board));
  await w.round([a, b], 60 * 60_000);
  assert.equal(a.requests.of(review), null, 'the owner\'s Desk stops asking after watchMs');
  assert.equal(await a.requests.inspected(review), true); await w.round([a, b]); await w.round([a, b]);
  assert.equal(a.requests.of(review)?.alias, b.joint.aliasOn(w.board), 'opened again an hour later: still vouched for');
  // A claim that is no longer announced ends by itself (the claimer's Desk closed): claimMs at most.
  w.clock.now += PRESENCE_LIMITS.claimMs + 1000; a.touch(); await a.joint.tick();
  assert.equal(w.hub.claimCount(), 0); assert.equal(a.requests.of(review), null);
  assert.equal(PRESENCE_LIMITS.claimMs, JP.REQUESTER.claimMs); assert.ok(JP.REQUESTER.announceMs <= 24 * 60 * 60_000);
});

// ================= 2. the ask's own records carry it, and nothing else does =================
test('Board ask records: prepare and run carry the vouched requester; it is not stored, not sent to a model, and a malformed one is refused', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-requester-ask-'));
  const BOARD = 'board-requester-sim', PROFILE = 'profile-requester-sim';
  const desk = openDeskStore({ dataDir: path.join(root, 'desk'), ownerScope: 'requester-sim' });
  desk.saveBoard(BOARD, { body: { version: 1, agenda: { id: BOARD, title: 'Sim Board' }, cards: [], shapes: [] }, expectedRevision: null });
  const profile = { lifecycle: 'active', activeRevision: 1, active: { revision: 1, hash: 'a'.repeat(64), body: { name: 'Sim Agent', model: null } } };
  const service = createBoardAgentAskService({ desk, profiles: { get: (id) => (id === PROFILE ? profile : null) }, selectContext: selectBoardAgentContext, decisionStatus: () => null, draft: null });
  t.after(() => { service.close(); desk.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let version = service.policy({ boardId: BOARD, action: 'save', expectedVersion: null, profileId: PROFILE, excerpts: ['금요일 방문자는 체육관 뒤 주차장을 이용합니다.', '금요일 모임은 아트리움에서 합니다.'], publicInstructions: '' }).policy.version;
  const issue = () => { const issued = service.policy({ boardId: BOARD, action: 'issue', expectedVersion: version }); version = issued.policy.version; return issued.askCode; };
  const requester = { board: randomUUID(), alias: 'm-0123456789abcdef' };
  const ask = (extra) => service.prepare({ boardId: BOARD, request: { ...request(), question: '금요일 방문자 주차', askCode: issue() }, mode: 'extract', ...extra });

  const plain = ask({});
  assert.equal(Object.hasOwn(plain, 'requester'), false, 'without a requester the record is exactly what it was');
  const plainRun = await service.run({ ticket: plain.ticket, confirm: true });
  assert.equal(Object.hasOwn(plainRun, 'requester'), false);

  const prepared = ask({ requester });
  assert.deepEqual(prepared.requester, requester); assert.deepEqual(Object.keys(prepared).filter((k) => !Object.hasOwn(plain, k)), ['requester']);
  const ran = await service.run({ ticket: prepared.ticket, confirm: true });
  assert.deepEqual(ran.requester, requester); assert.equal(ran.mode, 'extract'); assert.ok(ran.answer.includes('체육관'));
  assert.deepEqual(Object.keys(ran).filter((k) => !Object.hasOwn(plainRun, k)), ['requester']);
  assert.equal(ask({ requester: null }).requester, undefined);
  // refused whole: a name, an account, extra fields, another shape
  for (const bad of [{ board: requester.board, alias: 'Jin' }, { board: 'b1', alias: requester.alias }, { ...requester, name: '진' }, { alias: requester.alias }, 'm-0123456789abcdef', []])
    assert.throws(() => ask({ requester: bad }), (e) => e.code === 'INPUT' || /Invalid Board Agent ask fields/.test(e.message), JSON.stringify(bad));
  // kept no longer than the ask: the ticket lives in memory; the Desk's files never hold the alias
  service.close(); desk.close();
  const files = fs.readdirSync(path.join(root, 'desk'), { recursive: true }).map((f) => path.join(root, 'desk', String(f))).filter((f) => fs.statSync(f).isFile());
  assert.ok(files.length > 0); for (const file of files) assert.ok(!fs.readFileSync(file).includes(requester.alias), path.basename(file));

  // the owner's panel: the requester is read when the owner prepares, sent with prepare, checked on the way back, handed on with the answer
  const board = { id: BOARD, title: 'Sim Board' }, review = { ...request(), askCode: 'egask1-synthetic-not-a-code' };
  const policy = { version: 'v1', profileId: PROFILE, profileName: 'Sim Agent', profileRevision: 1, stale: false, excerpts: ['금요일 방문자는 체육관 뒤 주차장을 이용합니다.'], publicInstructions: '', replyStyle: 'concise' };
  const panel = (requesterOf, echo = (r) => r) => {
    const calls = [], answers = [];
    const flow = createBoardAgentAsk({ isCurrent: () => true, now: () => 1000, onState() {}, onAnswer: (_binding, result) => answers.push(result), loadProfiles: () => [{ id: PROFILE, name: 'Sim Agent', activeRevision: 1 }], requester: requesterOf,
      post: async (p, body) => {
        const endpoint = p.split('/').at(-1); calls.push({ endpoint, body });
        if (endpoint === 'policy') return { status: 200, body: { policy, availability: { decision: false, draft: false, model: null } } };
        const who = echo(body.requester);
        if (endpoint === 'prepare') return { status: 200, body: { ticket: 'synthetic-ticket', expiresAt: 5000, mode: 'extract', decisionMode: null, profileName: policy.profileName, profileRevision: 1, model: null, provider: null, draftModel: null, decisionModel: null,
          question: body.request.question, excerpts: policy.excerpts, replyStyle: 'concise', publicInstructions: '', ...(who ? { requester: who } : {}) } };
        if (endpoint === 'run') return { status: 200, body: { mode: 'extract', answer: policy.excerpts[0], source: 'local', ...(panel.ran ? { requester: panel.ran } : {}) } };
        return { status: 200, body: null };
      } });
    return { flow, calls, answers };
  };
  panel.ran = requester;
  const withWho = panel((seen) => (seen === review ? requester : null));
  await withWho.flow.open({ board, review }); await withWho.flow.prepare();
  assert.deepEqual(withWho.calls.find((x) => x.endpoint === 'prepare').body, { boardId: BOARD, request: review, mode: 'extract', requester });
  assert.equal(withWho.flow.view().step, 'preview'); await withWho.flow.run();
  assert.deepEqual(withWho.answers, [{ answer: policy.excerpts[0], mode: 'extract', source: 'local', requester }]);
  // a host that answers with another requester than the one asked for is not believed
  const swapped = panel(() => requester, () => ({ board: requester.board, alias: 'm-ffffffffffffffff' }));
  await swapped.flow.open({ board, review }); await swapped.flow.prepare();
  assert.equal(swapped.flow.view().step, 'stopped'); assert.deepEqual(swapped.answers, []);
  // no requester known (flag off, sharing off, a file from outside the Board): the call is byte-for-byte what it was
  panel.ran = null;
  const none = panel(() => null);
  await none.flow.open({ board, review }); await none.flow.prepare(); await none.flow.run();
  assert.deepEqual(none.calls.find((x) => x.endpoint === 'prepare').body, { boardId: BOARD, request: review, mode: 'extract' });
  assert.deepEqual(none.answers, [{ answer: policy.excerpts[0], mode: 'extract', source: 'local' }]);
  const typed = panel(() => ({ board: requester.board, alias: '진' }));
  await typed.flow.open({ board, review }); await typed.flow.prepare();
  assert.equal(Object.hasOwn(typed.calls.find((x) => x.endpoint === 'prepare').body, 'requester'), false, 'a malformed requester is dropped before it is sent');
});

// ================= 3. end to end: member B asks, the owner's Agent works, both consumers see B =================
// live: the placement runtime's own switch (the bridge: EGDESK_WORK_PLACEMENT=on). Only then may a decided "point" become a pointer fact, which the session
// turns into ONE chat message. In advisory (the default) the same decision is only recorded as what it WOULD do (lane L4, cycle 14). Who the requester is
// does not depend on it: the placement option is near B either way.
async function endToEnd(t, { ownerMustAct, live }) {
  const w = await world(t);
  const a = await w.person('a', { offset: { x: 0, y: 0 }, view: OWNER_VIEW });   // the owner, working at region A
  const b = await w.person('b', { offset: { x: 500, y: 300 }, view: B_SEES });   // member B, looking at another part of the shared space
  const c = await w.person('c', { offset: { x: -900, y: 40 }, view: r(-800, 100, 1024, 768) });
  b.joint.setShare(w.board, 'region'); c.joint.setShare(w.board, 'active'); await b.joint.idle(); await c.joint.idle();

  // ---- the bridge: presence mirror, run requesters, the placement judge, the real chat runtime with the audience rule ----
  const mirror = createPresenceMirror({ now: () => w.clock.now });
  const registry = createRunRequesters({ presence: mirror, now: () => w.clock.now });
  const acks = [];
  const judge = placementJudge();
  let placement = null;
  const hw = heartbeatWorld(t, { presence: mirror, audience: ({ run }) => registry.audience({ run }),
    policy: { message: (values) => (values.includes('pointer') ? 'pointer' : 'none') }, writer: (prompt) => (/on the desk/.test(prompt) ? POINTER : null),
    attentionPosted: (e) => { acks.push(e); if (e.provider === 'work_placement') placement.acknowledgePointer(e.key); } });
  // as the bridge builds it: enabled for advisory and on, live only for on; its clock and timers are the runtime's (virtual here)
  placement = createWorkPlacement({ client: judge, mode: () => (live ? 'on' : 'advisory'), enabled: () => true, live: () => live, calibrationLog: { record() {} }, now: () => hw.at(), setTimer: (fn, ms) => hw.chat.setTimer(fn, ms),
    contextFor: (key, options) => hw.chat.placementContextFor(key, options) }); // the bridge's wiring: the run's own request and answer, through its own gate
  const call = bridgeCalls([createPresenceMirrorHttpHandler({ mirror, enabled: () => true }), createRunRequesterHttpHandler({ requesters: registry, enabled: () => true }),
    createWorkPlacementHttpHandler({ placement, heartbeatFor: (key) => hw.chat.heartbeatFor(key) })]);
  const push = async () => { assert.equal((await call(PRESENCE_MIRROR.path, { rows: a.presence.snapshot() })).status, 200); };

  // ---- the owner's Desk: a plain canvas model (cards, one camera, one focus) and the surface's two presence hooks ----
  const canvas = { camera: { ...OWNER_VIEW }, focus: 'own-note', seq: 0,
    cards: [{ id: 'own-note', rect: r(100, 100, 500, 400), kind: 'memo', creator: 'user' }, { id: 'own-file', rect: r(700, 120, 400, 300), kind: 'file', creator: 'user' },
      // a published result card near B's side whose words the host may send, about another matter: the same-matter question is asked about it
      { id: 'res-lunch', rect: r(3700, 1200, 400, 300), kind: 'result', creator: 'agent', maySend: true, label: '점심 메뉴 투표 결과', excerpt: '이번 주 점심은 김치찌개로 정해졌습니다.' }] };
  const frozen = () => JSON.stringify({ camera: canvas.camera, focus: canvas.focus, own: canvas.cards.filter((x) => x.creator === 'user'), self: a.presence.snapshot()[0].viewport });
  const posts = [];
  const requesters = JP.createRunRequesters({ snapshot: () => a.presence.snapshot(), seated: (board, member) => a.joint.seated(board, member),
    post: (body) => { const p = call(RUN_REQUESTER.path, body); posts.push(p); return p; } });
  const sent = async () => (await Promise.all(posts.splice(0))).map((x) => [x.status, x.body.status]);
  // The surface's placement hook, as it is (the same expressions as noteWorkSurfacePlacement), wrapped the way installDeskPresence wraps it.
  const advised = [];
  const plainNote = (kind, landed, work) => {
    const taskId = work.runId || 'surface';
    const advisory = WP.advisoryPlacement({ presence: a.presence.snapshot(), cards: canvas.cards, obstacles: [], taskId, landed, surface: { kind, size: { width: landed.width, height: landed.height } },
      tasks: [{ id: taskId, state: 'running', requester: work.requester || null, waiting: [work.requester || 'self'], ownerMustAct: false, surfaces: [] }] });
    advised.push({ requester: work.requester || null, advisory });
    return advisory;
  };
  const note = requesters.wrap(plainNote);

  // ---- 1. B makes a Board question request; the owner opens it; the service says who ----
  const review = request();
  await b.requests.exported(review); await a.requests.inspected(review);
  await w.round([a, b, c]); await w.round([a, b, c]); await push();
  const who = a.requests.of(review), aliasB = b.joint.aliasOn(w.board);
  assert.deepEqual(who, { board: w.board, alias: aliasB });

  // ---- 2. the owner's Agent starts working on it in the owner's own conversation (no product screen does this yet: the hook is called here) ----
  const before = frozen();
  const run = await hw.dm('dm-task', '공개 자료로 방문자 주차 안내 초안을 만들어 주세요');
  const ref = { runId: run.r.runId, clientThreadId: 'dm-task', conversationId: run.r.conversationId };
  // Before anybody is named: both consumers see the local person, as they did.
  const landed = r(24, 24, 720, 520); // where a new card opens today: in the owner's view
  const asBefore = note('file', landed, ref).would;
  assert.equal(advised.at(-1).requester, null);
  assert.deepEqual(hw.chat.flowAudience(ref), hw.chat.flowAudience({ clientThreadId: 'other', conversationId: 'other' }), 'no entry: the default audience');
  // An alias nobody vouched for is not taken: not a random one, not a seated member's alias on another Board, not a name.
  assert.equal(requesters.set(ref, { board: w.board, alias: 'm-' + 'f'.repeat(16) }), false);
  assert.equal(requesters.set(ref, { board: randomUUID(), alias: aliasB }), false);
  assert.equal(requesters.set(ref, { board: w.board, alias: 'B' }), false); assert.deepEqual(await sent(), []);
  assert.deepEqual((await call(RUN_REQUESTER.path, { clientThreadId: 'dm-task', conversationId: null, requester: { board: w.board, alias: 'm-' + 'f'.repeat(16) } })), { status: 409, body: { status: 'unknown-member' } }, 'the bridge checks again');
  assert.equal(registry.size(), 0);
  // The vouched requester is taken.
  assert.equal(requesters.set(ref, who), true); assert.deepEqual(await sent(), [[200, 'held']]);

  // ---- 3. L4: the Agent opens a viewer for B's task. The option is near B; nothing is placed in, or moved inside, the owner's view. ----
  const advisory = note('file', landed, ref);
  assert.equal(advised.at(-1).requester, aliasB, 'the placement hook was handed the real requester');
  assert.deepEqual([advisory.dto.requester, advisory.dto.rule], ['M2', 'requester_working'], 'B waits for the run and is working: the rule is beside B\'s view'); assert.deepEqual(advisory.dto.members.map((m) => [m.alias, m.self]), [['M1', true], ['M2', false]]);
  assert.equal(advisory.would.kind, 'near_requester'); assert.equal(advisory.differs, true, 'today it lands in the owner\'s view; it would not');
  const tasks = () => [{ id: ref.runId, state: 'running', requester: requesters.for(ref), waiting: [aliasB], ownerMustAct: false, surfaces: [] }];
  const scene = () => ({ presence: a.presence.snapshot(), cards: canvas.cards.map((x) => ({ ...x, rect: { ...x.rect } })), tasks: tasks(), obstacles: [] });
  const options = WP.placementOptions(WP.enumerateWorkScene(scene()), { taskId: ref.runId, surface: FILE });
  const near = options.find((o) => o.kind === 'near_requester');
  assert.ok(near && !hits(near.rect, B_VIEW) && gapTo(near.rect, B_VIEW) < WP.PLACEMENT_RULES.nearViews * B_VIEW.width, 'just outside B\'s view');
  for (const o of options) assert.ok(!hits(o.rect, OWNER_VIEW), `${o.kind} stays out of the owner's view`);
  assert.ok(options.every((o) => o.kind !== 'in_requester_view'), 'B is active: nothing goes into B\'s view either');
  // The same request without the requester would have meant the owner's own surroundings.
  assert.deepEqual([asBefore.kind, asBefore.distance], ['near_requester', 'near']);
  const ownerSide = WP.placementOptions(WP.enumerateWorkScene({ ...scene(), tasks: [{ ...tasks()[0], requester: null, waiting: ['self'] }] }), { taskId: ref.runId, surface: FILE }).find((o) => o.kind === 'near_requester');
  assert.ok(gapTo(ownerSide.rect, OWNER_VIEW) < gapTo(ownerSide.rect, B_VIEW) && gapTo(near.rect, B_VIEW) < gapTo(near.rect, OWNER_VIEW));
  // The rule's spot is code. The only question, at a beat of the run's REAL heartbeat through the bridge route, is whether the nearby card is about
  // the same matter as the run's own request (it is not), so the rule's spot stands.
  const placed = await WP.placeSurface({ scene, request: { taskId: ref.runId, surface: FILE }, judge: async (dto) => {
    const queued = await call('/decision/work-placement/request', { clientThreadId: ref.clientThreadId, conversationId: ref.conversationId, dto });
    assert.deepEqual([queued.status, queued.body.status], [200, 'queued']);
    await hw.advance(S.beatMs); await placement.idle();
    const result = (await call('/decision/work-placement/result', { clientThreadId: ref.clientThreadId, conversationId: ref.conversationId, id: queued.body.id })).body;
    return result.status === 'decided' ? result : null;
  } });
  assert.deepEqual([placed.option.kind, placed.source, placed.rule], ['near_requester', 'rule', 'requester_working']); assert.deepEqual(placed.rect, near.rect);
  assert.equal(judge.calls.length, 1); assert.deepEqual(JSON.parse(judge.calls[0]).questions.map((q) => q.name), ['same_matter_R1']);
  const cardId = `agent-${++canvas.seq}`;
  canvas.cards.push({ id: cardId, rect: { ...placed.rect }, kind: 'file', creator: 'agent', taskId: ref.runId }); // opened, not activated
  assert.equal(frozen(), before, 'the owner\'s camera, focus, own cards and own presence row are exactly as they were');
  // what the judge read: the run's own request and the card's words (maySend); never a member alias, id, conversation key or coordinate
  for (const text of judge.calls) { assert.doesNotMatch(text, /m-[0-9a-f]{16}|own-note|res-lunch|dm-task|M2|3700/); assert.match(text, /방문자 주차 안내 초안/); }

  // ---- 4. L3: who is waiting, and may a message go into this conversation ----
  const audience = hw.chat.flowAudience(ref);
  assert.deepEqual([audience.waiting, audience.addresseePresent, audience.addresseeInConversation, audience.postable], ['requester', true, false, false],
    'B waits and is present, but B is not in the owner\'s conversation: no progress message is written into it for B');
  assert.deepEqual(registry.audience({ run: ref }), { requester: aliasB, owner: 'self', participants: ['self'] });
  assert.equal(registry.audience({ run: { ...ref, board: true } }), null);

  // ---- 5. the run ends; the result is placed; does it need the owner? ----
  await run.final('방문자 주차 안내 초안을 만들었습니다.');
  assert.equal(hw.chat.heartbeatFor('dm-task')?.state, 'running');
  await w.round([a, b, c]); await push();
  const doneScene = () => WP.enumerateWorkScene({ ...scene(), tasks: [{ id: ref.runId, state: ownerMustAct ? 'waiting_owner' : 'finished', requester: requesters.for(ref), waiting: [aliasB], ownerMustAct, surfaces: [{ kind: 'file', cardId }] }] });
  const attention = WP.attentionRequest(doneScene(), { taskId: ref.runId, cardId });
  assert.deepEqual([attention.outcomes.owner.kind, attention.outcomes.owner.forMember, attention.outcomes.requester.kind, attention.outcomes.requester.forMember], ['point', 'M1', 'point', 'M2'],
    'both outcomes by code: B is active, so B is told rather than moved to; the owner is never moved to');
  const messagesBefore = run.assistant().length, eventsBefore = hw.events.length;
  assert.equal((await call('/decision/work-placement/request', { clientThreadId: ref.clientThreadId, conversationId: ref.conversationId, dto: attention.dto })).body.status, 'queued');
  // The placement runtime nudges the heartbeat itself: judged within half a second of the request, not at the idle grid.
  await hw.advance(S.nudgeMs); await placement.idle();
  const fact = { ...(placement.facts('dm-task') ?? {}) }, onHeartbeat = { ...(run.hb.facts().sources.work_placement ?? {}) };
  const record = placement.records().at(-1);
  const routeNow = pointerRoute({ person: ownerMustAct ? 'owner' : 'requester', audience: registry.audience({ run: ref }), presence: mirror.snapshot(), others: [] });
  assert.deepEqual(run.assistant().slice(messagesBefore), [], 'nothing is posted at the beat that judged');
  // The pointer's own nudge (one beat interval later), then two more beats: whatever is posted is posted once.
  await hw.advance(WORK_PLACEMENT_LIMITS.renudgeMs + S.nudgeMs); await placement.idle(); await hw.advance(S.beatMs * 2); await placement.idle(); await hw.advance(S.beatMs * 2);
  const posted = run.assistant().slice(messagesBefore);
  assert.equal(frozen(), before, 'still nothing moved in the owner\'s view');
  return { w, a, b, hw, run, ref, aliasB, placement, registry, requesters, mirror, fact, onHeartbeat, record, judge, routeNow, posted, acks, eventsBefore, sent, push, call, canvas, cardId };
}

test('end to end: member B asks -> the viewer option is near B, the owner\'s view is untouched, and a finished result the owner need not act on does NOT point the owner', async (t) => {
  const e = await endToEnd(t, { ownerMustAct: false, live: true });
  assert.deepEqual([e.fact.pointerPending, e.fact.pointerFor, e.fact.pointerNeeds], [true, 'requester', 'review'], 'the placement runtime says: this is for the requester');
  assert.deepEqual(e.onHeartbeat, e.fact, 'the same fact on the conversation\'s heartbeat'); assert.deepEqual([e.record.would.kind, e.record.pointer], ['point', 'raised']);
  assert.equal(e.placement.facts('dm-task').pointerPending, true, 'nobody could be told, so the fact is still there (it ends by itself after pointerMs)');
  assert.deepEqual(e.routeNow, { target: null, reason: 'no_conversation' }, 'the requester has no conversation on the owner\'s Desk');
  assert.deepEqual(e.posted, [], 'no pointer in the owner\'s conversation'); assert.deepEqual(e.acks, []);
  assert.deepEqual(e.hw.events.slice(e.eventsBefore).filter((x) => /^message\./.test(x.event)), [], 'no message event at all');
  t.diagnostic(`owner need not act: pointerFor=${e.fact.pointerFor} route=${e.routeNow.reason} ownerMessages=${e.posted.length}`);

  // The run record ends: the requester is forgotten on both sides, and both consumers are back to the local person.
  assert.equal(e.requesters.set(e.ref, null), true); assert.deepEqual(await e.sent(), [[200, 'cleared']]);
  assert.equal(e.requesters.for(e.ref), null); assert.equal(e.registry.audience({ run: e.ref }), null); assert.equal(e.registry.size(), 0);
});

test('end to end: the same task now needs the OWNER\'s decision -> one pointer message to the owner, in the owner\'s own conversation; B\'s leaving ends the identity', async (t) => {
  const e = await endToEnd(t, { ownerMustAct: true, live: true });
  assert.deepEqual([e.fact.pointerPending, e.fact.pointerFor, e.fact.pointerNeeds], [true, 'owner', 'owner_action']); assert.deepEqual([e.record.would.kind, e.record.pointer], ['point', 'raised']);
  assert.deepEqual(e.routeNow, { target: 'here', present: true });
  assert.deepEqual(e.posted, [POINTER], 'exactly one pointer message, to the owner'); assert.deepEqual(e.acks, [{ key: 'dm-task', provider: 'work_placement' }]);
  assert.equal(e.placement.facts('dm-task').pointerPending, false, 'withdrawn once posted');
  const asked = e.hw.beatRequests.map(r => r.input.join('\n')).join('\n'), prompt = e.hw.forkPrompts.at(-1);
  // L3 c16: the owner must decide, so whether the work needs them is not asked (presence and view are code too); only a message already
  // posted to the owner may be asked about (told_N: does it already say where).
  assert.ok(!e.hw.beatRequests.some(r => r.names.includes('message__pointer')), 'a decision waiting for the owner needs them by definition');
  assert.doesNotMatch(asked, new RegExp(e.aliasB), 'no member id reached any judgment'); assert.doesNotMatch(prompt, new RegExp(`${e.aliasB}|주차|방문자`), 'no member id and no task text reached the writer');
  t.diagnostic(`owner must act: route=${e.routeNow.target} ownerMessages=${e.posted.length} acks=${e.acks.length}`);

  // Retention: the requester is held no longer than the member is there to be named.
  // B turns sharing off -> not in the snapshot -> the placement hook gets nobody, and the bridge's audience for a NEW entry is refused.
  e.b.joint.setShare(e.w.board, 'off'); await e.b.joint.idle(); await e.w.round([e.a]); await e.push();
  assert.equal(e.requesters.for(e.ref), null, 'the window hands out the alias only while that member is in the live snapshot');
  assert.equal(e.requesters.set({ clientThreadId: 'dm-next', conversationId: 'native-next' }, { board: e.w.board, alias: e.aliasB }), false);
  assert.deepEqual((await e.call(RUN_REQUESTER.path, { clientThreadId: 'dm-next', conversationId: null, requester: { board: e.w.board, alias: e.aliasB } })).body, { status: 'unknown-member' });
  // The pointer rule with a requester who is gone: nothing can be routed to them (away), the owner's route is unchanged.
  assert.deepEqual(pointerRoute({ person: 'requester', audience: e.registry.audience({ run: e.ref }), presence: e.mirror.snapshot(), others: [] }), { target: null, reason: 'away' });
  // The entry itself ends with the run record's time bound.
  e.w.clock.now += RUN_REQUESTER.ttlMs + 1000;
  assert.equal(e.registry.audience({ run: e.ref }), null); assert.equal(e.registry.size(), 0);
  assert.equal(RUN_REQUESTER.ttlMs, JP.REQUESTER.runMs);
});

test('end to end, advisory placement (the default): the requester is still B and the option is still near B, but a decided "point" is only RECORDED; no fact, no message, for either kind of result', async (t) => {
  for (const ownerMustAct of [true, false]) {
    const e = await endToEnd(t, { ownerMustAct, live: false }); // the first half of endToEnd already asserted: requester M2, near B, the owner's view untouched
    // the place's one content question, and for a finished result the owner question; the code already knows when the owner must act
    assert.equal(e.judge.calls.length, ownerMustAct ? 1 : 2, 'questions only where code cannot know');
    assert.deepEqual([e.record.kind, e.record.would.kind, e.record.pointer, e.record.source], ['attention', 'point', 'advisory', ownerMustAct ? 'rule' : 'decision'], 'recorded as what it WOULD do');
    assert.deepEqual([e.fact.pointerPending, e.fact.pointerFor, e.onHeartbeat.pointerPending], [false, undefined, false], 'no pointer fact is raised');
    assert.equal(e.placement.facts('dm-task').pointerPending, false);
    assert.deepEqual(e.posted, [], 'no message in the owner\'s conversation, even when the owner must act'); assert.deepEqual(e.acks, []);
    assert.deepEqual(e.hw.events.slice(e.eventsBefore).filter((x) => /^message\./.test(x.event)), [], 'no message event at all');
    assert.equal(e.hw.forkPrompts.filter((prompt) => /on the desk/.test(prompt)).length, 0, 'the writer was never asked for a pointer');
    // The route the audience rule WOULD give is unchanged by the mode: it is the missing fact, not the requester, that keeps the session silent.
    assert.deepEqual(e.routeNow, ownerMustAct ? { target: 'here', present: true } : { target: null, reason: 'no_conversation' });
    t.diagnostic(`advisory, ownerMustAct=${ownerMustAct}: record=${e.record.would.kind}/${e.record.pointer} fact=${e.fact.pointerPending} ownerMessages=${e.posted.length}`);
  }
});

// ================= 4. off by default, and where it is wired =================
test('default path: without the presence flag nothing of this exists; the bridge route is closed and guarded', async () => {
  const mirror = createPresenceMirror({ now: () => 1000 }), registry = createRunRequesters({ presence: mirror, now: () => 1000 });
  const off = bridgeCalls([createRunRequesterHttpHandler({ requesters: registry, enabled: () => false })]);
  assert.deepEqual(await off(RUN_REQUESTER.path, { clientThreadId: 'dm', conversationId: null, requester: null }), { status: 404, body: { status: 'off' } });
  const on = bridgeCalls([createRunRequesterHttpHandler({ requesters: registry, enabled: () => true })]);
  assert.equal((await on(RUN_REQUESTER.path, { clientThreadId: 'dm', conversationId: null, requester: null }, { headers: { origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await on(RUN_REQUESTER.path, { clientThreadId: 'dm', conversationId: null, requester: null }, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await on(RUN_REQUESTER.path, { clientThreadId: 'dm', requester: null })).status, 400, 'closed body');
  assert.equal((await on(RUN_REQUESTER.path, { clientThreadId: 'dm', conversationId: null, requester: { board: randomUUID(), alias: 'm-0123456789abcdef', name: 'x' } })).status, 400);
  assert.equal((await on(RUN_REQUESTER.path, { clientThreadId: '', conversationId: null, requester: null })).status, 400);
  assert.deepEqual(await on(RUN_REQUESTER.path, { clientThreadId: 'dm', conversationId: null, requester: null }), { status: 200, body: { status: 'cleared' } });
  assert.equal(registry.audience({ run: { clientThreadId: 'dm', conversationId: null } }), null);

  const here = path.dirname(new URL(import.meta.url).pathname);
  const server = fs.readFileSync(path.join(here, 'codex-bridge-server.mjs'), 'utf8'), surface = fs.readFileSync(path.join(here, '../overlay/JS/eg-desk-surface.uc.js'), 'utf8');
  assert.match(server, /createRunRequesterHttpHandler\(\{ requesters: runRequesters, enabled: \(\) => process\.env\.EGDESK_PRESENCE === 'on', port: BRIDGE_PORT \}\)/);
  assert.match(server, /process\.env\.EGDESK_PRESENCE === 'on' \? \{ presence: presenceMirror, audience: \(\{ run \}\) => runRequesters\.audience\(\{ run \}\) \} : \{\}/);
  // The rig's two placement modes are the bridge's own: enabled for advisory and on, a pointer fact only when on.
  assert.match(server, /enabled: \(\) => \['advisory', 'on'\]\.includes\(process\.env\.EGDESK_WORK_PLACEMENT\),/); assert.match(server, /live: \(\) => process\.env\.EGDESK_WORK_PLACEMENT === 'on'/);
  // The surface: the placement hook's own line is L4's, unchanged; the wrapper and the request side are installed inside installDeskPresence only.
  assert.ok(surface.includes("tasks: [{ id: taskId, state: 'running', requester: work.requester || null, waiting: [work.requester || 'self'], ownerMustAct: false, surfaces: [] }] });"));
  const install = surface.slice(surface.indexOf('function installDeskPresence()'), surface.indexOf('return state.presence;', surface.indexOf('function installDeskPresence()')));
  assert.match(install, /if \(state\.presence \|\| !JointPresence\.presenceEnabled\(readSurfacePref\(JointPresence\.PRESENCE_PREF\)\)\) return null;/);
  for (const piece of ['JointPresence.createRunRequesters(', 'state.runRequesters.wrap(state.noteWorkSurfacePlacement)', 'JointPresence.createRequestRequesters(', "'/presence/requester'"]) assert.ok(install.includes(piece), piece);
  assert.equal(surface.split('createRunRequesters(').length, 2); assert.equal(surface.split('createRequestRequesters(').length, 2);
  for (const use of ['state.requestRequesters?.exported(review)', 'state.requestRequesters?.inspected(view.review)', 'state.requestRequesters?.of(review) ?? null']) assert.ok(surface.includes(use), use);
});
