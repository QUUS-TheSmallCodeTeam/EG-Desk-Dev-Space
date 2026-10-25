import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFunction } from 'node:vm';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import * as ChatState from '../overlay/resources/EGDeskChatState.sys.mjs';
import * as FileView from '../overlay/resources/EGDeskFileView.sys.mjs';
import { createEGDeskFileHttpAdapter } from '../helper/egdesk-file-http.mjs';
import { readSurfaceSource } from './egdesk-surface-source.mjs';

// Actual host bridge methods, native prepared-grant adapter, HTTP parser and
// SQLite project store. Only the OS picker result is supplied; no listener,
// provider, browser, terminal or Git process is started.
const source = readSurfaceSource();
const declaration = name => {
  const start = source.indexOf(`  function ${name}(`), end = source.indexOf('\n  }', start);
  assert.ok(start >= 0 && end > start); return source.slice(start, end + 4);
};
const method = (name, deps) => {
  const prefix = name === 'createProjectScope' ? '' : 'async ';
  const start = source.indexOf(`      ${prefix}${name}(`), end = source.indexOf('\n      },', start);
  assert.ok(start >= 0 && end > start);
  return compileFunction(`return ({ ${source.slice(start, end + 8)} }).${name};`, Object.keys(deps))(...Object.values(deps));
};
const deferred = () => Promise.withResolvers();

async function fixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-room-override-')));
  const boardRoot = path.join(temp, 'Board source'), roomRoot = path.join(temp, 'Room selected');
  await fs.mkdir(boardRoot); await fs.mkdir(roomRoot);
  const adapter = createEGDeskFileHttpAdapter({ draftDirectory: path.join(temp, 'drafts') });
  t.after(async () => { await adapter.close(); await fs.rm(temp, { recursive: true, force: true }); });
  const calls = [], hooks = { before: async () => {}, after: async () => {} };
  const rawRequest = async (route, body, headers = {}) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
      method: 'POST', url: route, headers: { host: '127.0.0.1:39218', 'content-type': 'application/json',
        ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])) }, socket: { remoteAddress: '127.0.0.1' },
    });
    const res = { writeHead(status) { this.status = status; }, end(bytes) { this.body = JSON.parse(bytes); } };
    await adapter.handle(req, res); return res.body;
  };
  const state = { codex: { activeThreadId: 'local-room', codexAccountKey: 'account-a', authStatus: { accountEmail: 'a@example.test', isLoggedIn: true },
    threads: [{ id: 'local-room', clientBindingId: 'original-wire-room', engineId: 'codex', messages: [],
      requestProjectTarget: { boardId: 'request-board', projectId: 'request-project', rootId: 'request-root' }, inputSources: [{ id: 'kept' }] }],
    threadDrafts: { 'local-room': 'keep this request' }, threadDraftRevisions: { 'local-room': 7 } } };
  const epochScope = ChatState.createChatEpochScope(), defaults = new Map();
  let pick = async () => roomRoot, pickerCalls = 0, emits = 0;
  const deps = { state, ChatState, epochScope, chatRoomProjectDefaults: defaults, chatRoomProjectPreparations: new WeakMap(),
    CHAT_ROOM_PROJECT_UNAVAILABLE: '방 기본 프로젝트를 확인하지 못했습니다.',
    window: { AbortController, setTimeout, clearTimeout },
    getCodexThreadById: (_state, id) => state.codex.threads.find(thread => thread.id === id), emit: () => { emits++; },
    pickNativeRoomProjectDirectory: async () => { pickerCalls++; return pick(); },
    ChromeUtils: { importESModule(url) { assert.equal(url, 'chrome://userchrome/content/EGDeskFileView.sys.mjs'); return FileView; } },
    fetchJson: async (route, options) => {
      assert.equal(options.method, 'POST');
      const call = { route, body: JSON.parse(options.body), headers: options.headers, signal: options.signal }; calls.push(call);
      await hooks.before(call);
      if (options.signal?.aborted) throw new Error('aborted before dispatch');
      const packet = await rawRequest(route, call.body, options.headers);
      await hooks.after(call, packet); return packet;
    },
  };
  for (const name of ['createChatProjectScope', 'normalizeChatRoomProjectDefault', 'chatRoomProjectState']) {
    deps[name] = compileFunction(declaration(name) + `\nreturn ${name};`, Object.keys(deps))(...Object.values(deps));
  }
  const bridge = Object.fromEntries(['createProjectScope', 'prepareRoomProjectFolder', 'saveRoomProjectOverride'].map(name => [name, method(name, deps)]));
  state.codexBridge = bridge;
  const originalDraft = JSON.stringify(state.codex);
  return { state, bridge, epochScope, calls, hooks, defaults, boardRoot, roomRoot, originalDraft,
    thread: () => state.codex.threads[0], setPicker: callback => { pick = callback; }, pickerCalls: () => pickerCalls, emits: () => emits,
    count: suffix => calls.filter(call => call.route.endsWith(suffix)).length,
    prepare: signal => bridge.prepareRoomProjectFolder('local-room', 'original-wire-room', { signal }),
    save: (prepared, signal) => bridge.saveRoomProjectOverride('local-room', 'original-wire-room', prepared, { signal }),
    async read(roomId = 'original-wire-room') { const packet = await rawRequest('/v1/files/projects/room-default', { roomId }); assert.equal(packet.ok, true); return packet.result; },
    async seedBoard() {
      const service = FileView.createEGDeskFileServiceCallbacks({ request: (route, body, options) => rawRequest(route, body, options?.headers) });
      const native = FileView.createEGDeskNativeFilePickers({ service, pickDirectory: async () => boardRoot });
      const project = await native.chooseProjectFolder({ boardId: 'saved-board' });
      const packet = await rawRequest('/v1/files/projects/room-default/save', { roomId: 'original-wire-room', boardId: 'saved-board',
        expectedProjectId: project.projectId, expectedRootId: project.rootId });
      assert.equal(packet.ok, true); return packet.result;
    },
  };
}

test('room override: native callback uses the owned window and returns only the OS folder result', async () => {
  const pending = [], window = { browsingContext: { owned: true } }, Ci = { nsIFilePicker: { modeGetFolder: 2, returnOK: 0 } };
  const Cc = { '@mozilla.org/filepicker;1': { createInstance(type) {
    assert.equal(type, Ci.nsIFilePicker); const picker = { init(...args) { this.args = args; }, open(callback) { this.reply = callback; } };
    pending.push(picker); return picker;
  } } };
  const pick = compileFunction(declaration('pickNativeRoomProjectDirectory') + '\nreturn pickNativeRoomProjectDirectory;', ['window', 'Cc', 'Ci'])(window, Cc, Ci);
  const selecting = pick(); assert.deepEqual(pending[0].args, [window.browsingContext, '이 방에서 사용할 프로젝트 폴더', Ci.nsIFilePicker.modeGetFolder]);
  pending[0].file = { path: '/chosen/by/person' }; pending[0].reply(0); assert.equal(await selecting, '/chosen/by/person');
  const cancelling = pick(); pending[1].reply(1); assert.equal(await cancelling, null);
});

test('room override: prepare/Cancel have zero binding writes; forged or saved-path handles cannot Save', async t => {
  const h = await fixture(t), prepared = await h.prepare();
  assert.equal(prepared.displayPath, h.roomRoot); assert.equal(Object.isFrozen(prepared), true);
  assert.deepEqual(Object.keys(prepared), ['displayPath', 'expiresAt', 'consume', 'cancel']);
  assert.doesNotMatch(JSON.stringify(prepared), /selectionId|requestId|token|channel/);
  assert.equal(h.count('/attach'), 0); assert.equal((await h.read()).status, 'none');
  assert.equal(prepared.cancel(), true); assert.equal(prepared.cancel(), false);
  await assert.rejects(h.save(prepared)); await assert.rejects(h.save({ displayPath: h.roomRoot, consume: async () => assert.fail('fabricated consume') }));
  assert.equal(h.count('/attach'), 0); assert.equal(h.count('/inherit'), 0); assert.equal(h.count('/roots'), 0);
  assert.equal(JSON.stringify(h.state.codex), h.originalDraft);
  h.setPicker(async () => null); assert.equal(await h.prepare(), null); assert.equal(h.count('/attach'), 0);
});

test('room override: explicit Save consumes once for the original binding, keeps Board inheritance and request draft', async t => {
  const h = await fixture(t), inherited = await h.seedBoard(), prepared = await h.prepare();
  const value = await h.save(prepared);
  assert.equal(value.source, 'room'); assert.equal(value.project.displayPath, h.roomRoot);
  assert.deepEqual(value.inheritance, inherited.inheritance); assert.equal(value.inheritance.boardId, 'saved-board');
  assert.equal(h.count('/attach'), 1); assert.equal(h.count('/roots'), 0);
  const attach = h.calls.find(call => call.route.endsWith('/attach'));
  assert.deepEqual(Object.keys(attach.body), ['roomId', 'selectionId']); assert.equal(attach.body.roomId, 'original-wire-room');
  assert.ok(attach.headers['X-EGDesk-Picker-Channel']);
  await assert.rejects(h.save(prepared)); assert.equal(prepared.cancel(), false); assert.equal(h.count('/attach'), 1);
  assert.equal(JSON.stringify(h.state.codex), h.originalDraft);
});

test('room override: explicit clear re-reads saved Board inheritance or none without choosing a folder', async t => {
  for (const baseline of [false, true]) await t.test(baseline ? 'Board inheritance' : 'no baseline', async t => {
    const h = await fixture(t); if (baseline) await h.seedBoard(); await h.save(await h.prepare());
    const picks = h.pickerCalls(), value = await h.save(null);
    assert.equal(value.source, baseline ? 'board' : null); assert.equal(value.status, baseline ? 'connected' : 'none');
    assert.equal(value.override, null); if (baseline) assert.equal(value.project.displayPath, h.boardRoot);
    assert.deepEqual(h.calls.find(call => call.route.endsWith('/inherit')).body, { roomId: 'original-wire-room' });
    assert.equal(h.count('/inherit'), 1); assert.equal(h.pickerCalls(), picks);
    assert.equal(h.calls.at(-1).route, '/v1/files/projects/room-default'); assert.equal(JSON.stringify(h.state.codex), h.originalDraft);
  });
});

test('room override: late picker results and ready grants cannot cross account, engine, profile, room, binding, epoch or view', async t => {
  const changes = {
    account: h => { h.state.codex.authStatus = { accountEmail: 'b@example.test', isLoggedIn: true }; },
    engine: h => { h.thread().engineId = 'claude'; },
    profile: h => { h.thread().engineProfileId = 'other'; },
    room: h => { h.state.codex.activeThreadId = 'other'; },
    binding: h => { h.thread().clientBindingId = 'another-wire-room'; },
    epoch: h => h.epochScope.reset('codex'),
    view: (_h, controller) => controller.abort(),
  };
  for (const phase of ['picking', 'ready']) for (const [name, change] of Object.entries(changes)) await t.test(`${phase} ${name}`, async t => {
    const h = await fixture(t), pending = deferred(), entered = deferred(), controller = new AbortController();
    if (name === 'profile') Object.assign(h.thread(), { engineId: 'claude', engineProfileId: 'slot-a' });
    if (phase === 'picking') h.setPicker(async () => { entered.resolve(); return pending.promise; });
    const preparing = h.prepare(controller.signal); let prepared;
    if (phase === 'picking') await entered.promise; else prepared = await preparing;
    change(h, controller);
    if (phase === 'picking') { pending.resolve(h.roomRoot); prepared = await preparing; assert.equal(prepared, null); }
    else { await assert.rejects(h.save(prepared, controller.signal)); prepared.cancel(); }
    assert.equal(h.count('/attach'), 0); assert.equal(h.count('/inherit'), 0); assert.equal((await h.read()).status, 'none');
  });
});

test('room override: duplicate Save and cancellation after dispatch never roll back or retry the original attach', async t => {
  const h = await fixture(t), entered = deferred(), release = deferred(), controller = new AbortController();
  const prepared = await h.prepare(controller.signal);
  h.hooks.after = async call => { if (call.route.endsWith('/attach')) { entered.resolve(); await release.promise; } };
  const saving = h.save(prepared, controller.signal), rejected = assert.rejects(saving, /저장 결과를 확인하지 못/); await entered.promise;
  assert.equal((await h.read()).source, 'room'); await assert.rejects(h.save(prepared, controller.signal));
  controller.abort(); assert.equal(prepared.cancel(), false); release.resolve(); await rejected;
  assert.equal(h.count('/attach'), 1); assert.equal(h.count('/inherit'), 0); assert.equal((await h.read()).source, 'room');
  assert.equal(h.count('/room-default'), 0, 'no follow-up read from the invalidated view');
  assert.equal(JSON.stringify(h.state.codex), h.originalDraft);
});

test('room override: unknown attach/clear replies retain request draft and require explicit reinspection, never auto retry', async t => {
  for (const operation of ['attach', 'inherit']) await t.test(operation, async t => {
    const h = await fixture(t); await h.seedBoard();
    if (operation === 'inherit') await h.save(await h.prepare());
    const prepared = operation === 'attach' ? await h.prepare() : null;
    const beforeRead = h.count('/room-default');
    h.hooks.after = async call => { if (call.route.endsWith('/' + operation)) throw new Error('reply lost after commit'); };
    await assert.rejects(h.save(prepared), /자동으로 다시 저장하지 않습니다/);
    assert.equal(h.count('/' + operation), 1); assert.equal(h.count('/room-default'), beforeRead);
    assert.equal(h.defaults.get('local-room').status, 'error');
    assert.equal((await h.read()).source, operation === 'attach' ? 'room' : 'board');
    assert.equal(JSON.stringify(h.state.codex), h.originalDraft);
    if (prepared) { await assert.rejects(h.save(prepared)); assert.equal(h.count('/attach'), 1); }
  });
});

test('room override: late write/read replies cannot publish across account, room, binding, engine, profile or view changes', async t => {
  for (const phase of ['attach', 'room-default']) for (const mode of ['account', 'room', 'binding', 'engine', 'profile', 'view']) await t.test(`${phase} ${mode}`, async t => {
    const h = await fixture(t), entered = deferred(), release = deferred(), controller = new AbortController();
    if (mode === 'profile') Object.assign(h.thread(), { engineId: 'claude', engineProfileId: 'slot-a' });
    const prepared = await h.prepare(controller.signal);
    h.hooks.after = async call => { if (call.route.endsWith('/' + phase)) { entered.resolve(); await release.promise; } };
    const saving = h.save(prepared, controller.signal), rejected = assert.rejects(saving, /저장 결과를 확인하지 못/); await entered.promise;
    const beforeEmits = h.emits();
    if (mode === 'account') h.state.codex.authStatus = { accountEmail: 'b@example.test', isLoggedIn: true };
    if (mode === 'room') h.state.codex.activeThreadId = 'other';
    if (mode === 'binding') h.thread().clientBindingId = 'new-room-binding';
    if (mode === 'engine') h.thread().engineId = 'claude';
    if (mode === 'profile') h.thread().engineProfileId = 'slot-b';
    if (mode === 'view') controller.abort();
    release.resolve(); await rejected;
    assert.notEqual(h.defaults.get('local-room').status, 'ready'); assert.equal(h.emits(), beforeEmits);
    assert.equal(h.count('/attach'), 1); assert.equal(h.count('/room-default'), phase === 'attach' ? 0 : 1);
    assert.equal(h.state.codex.threadDrafts['local-room'], 'keep this request');
    assert.deepEqual(h.thread().requestProjectTarget, { boardId: 'request-board', projectId: 'request-project', rootId: 'request-root' });
    assert.equal((await h.read()).source, 'room', 'discarding a late reply does not roll back a completed write');
  });
});
