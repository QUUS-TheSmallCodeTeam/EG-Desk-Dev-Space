// Main mounts this sidecar before synthetic fallbacks. No listener or process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { openChatStore } from '../helper/egdesk-chat-store.mjs';
import { CodexChatRuntime } from '../helper/codex-chat-runtime.mjs';
import { createEGDeskFileMount } from '../helper/egdesk-file-mount.mjs';
import { createEGDeskFileHttpAdapter, EGDESK_FILE_ENDPOINTS } from '../helper/egdesk-file-http.mjs';
import { openEGDeskManagedDraftStore } from '../helper/egdesk-managed-drafts.mjs';
import { createChatHttpHandler, guardBridgeRequest, readJsonBody, sendJson, setBridgeCors } from '../helper/codex-bridge-http.mjs';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { assertFreshQaFixtureProfile, qaBridgeConfig } from './egdesk-qa-fixture-isolation.mjs';
import { createPrivateQaTempDirectory, isOwnedAndPrivate } from './egdesk-qa-platform.mjs';
import { assertOrdinarySend } from './egdesk-chat-qa-contract.sys.mjs';

export const CHAT_ORIGIN_FILE_SEED = 'EGDESK_QA_CHAT_ORIGIN_FILE';
export const CHAT_ORIGIN_FILE_STATE = '/__qa/chat-origin-file/state';
export const CHAT_ORIGIN_FILE_CONTROL = '/__qa/chat-origin-file/control';
export const CHAT_ORIGIN_FILE_BOARDS = Object.freeze({ original: 'qa-origin-original', other: 'qa-origin-other' });
export const CHAT_ORIGIN_FILE_TEXT = Object.freeze({ historic: 'Owned fixture source\nHISTORIC\nold third line\n',
  current: 'Owned fixture source\nCURRENT\nnew third line\n', other: 'OTHER_BOARD_DO_NOT_READ\n' });
export const CHAT_ORIGIN_FILE_OUTPUT = 'FAIL source.test.js\n  ● HISTORIC retained failure\n\n    Expected: HISTORIC\n    Received: old value\n\n      at fixture (source.test.js:2:3)\n\nTests: 1 failed, 1 total\n';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (code, message, httpStatus = 403) => Object.assign(new Error(message), { code, httpStatus });
const opaque = value => typeof value === 'string' && !!value.trim() && value.length <= 300 && !value.includes('\0');
const record = (list, value, limit = 1024) => { if (list.length >= limit) throw fail('QA_TRACE_LIMIT', 'Bounded fixture evidence is full', 429); list.push(value); return value; };
const FILE_READS = new Set(['readRoomProjectDefault', 'openProject', 'listDirectory', 'resolvePath', 'readFile', 'createDraft', 'readDraft']);
const ORIGINAL_WRITES = new Set(['saveOriginal', 'revertReviewed', 'deleteCreated', 'saveAs']);

export function chatOriginFileFixtureEnabled(env = process.env) {
  const flag = env.EGDESK_QA_CHAT_ORIGIN_FILE_FIXTURE;
  if (flag == null || flag === '0') return false;
  if (flag !== '1' || env.EGDESK_QA_FIXTURE_TRANSPORT !== '1' || env.EGDESK_QA_REAL_TURN !== '0') throw fail('QA_ORIGIN_FILE_OPT_IN', 'Explicit model-free fixture mode is required');
  for (const [key, value] of Object.entries(env)) {
    if ((/^EGDESK_QA_.*_FIXTURE$/.test(key) && key !== 'EGDESK_QA_CHAT_ORIGIN_FILE_FIXTURE'
        || ['EGDESK_QA_BROWSER_NEGATIVE', 'EGDESK_QA_BROWSER_RELAY'].includes(key)) && value != null && value !== '' && value !== '0') {
      throw fail('QA_ORIGIN_FILE_MODE_CONFLICT', `Origin File fixture excludes ${key}`);
    }
  }
  return true;
}

/**
 * await createChatOriginFileFixture({profile,token,env,broadcast})
 *   -> {handle(req,res,url), snapshot(), dispose()}.
 * Start on a fresh owned profile BEFORE Firefox. A two-Board catalog is seeded
 * in that profile only. Mount handle BEFORE every /chat/* and /v1/files/*
 * fallback; all those paths are consumed here, including refusals. Broadcast
 * actual chat.event frames unchanged through the transport's event:codex SSE.
 * Controls require the token: prepare-room {clientThreadId}, advance-current,
 * choose-other-default, missing-file, disconnect-root, replace-root, account-change.
 * Only prepare-room/advance-current are needed for the minimal UI run.
 * Evidence/temp files are retained on dispose; Main owns eventual cleanup.
 */
export async function createChatOriginFileFixture({ profile, token, env = process.env, broadcast = () => {} } = {}) {
  assert.equal(chatOriginFileFixtureEnabled(env), true);
  assert.ok(typeof token === 'string' && token.length >= 16, 'Owned fixture token required');
  if (env.EGDESK_QA_FIXTURE_TOKEN != null) assert.equal(env.EGDESK_QA_FIXTURE_TOKEN, token);
  assert.equal(typeof broadcast, 'function');
  const config = qaBridgeConfig(env), manifest = assertQaFixtureManifest(profile);
  assertFreshQaFixtureProfile(profile);
  assert.notEqual(process.platform, 'win32', 'No-process fixture uses the private POSIX QA lane');
  const prefsFile = path.join(manifest.profile, 'prefs.js');
  assert.equal(fs.existsSync(prefsFile), false, 'Use a fresh profile without pre-existing preferences');
  const root = createPrivateQaTempDirectory('egdesk-chat-origin-file-');
  const chatDir = path.join(root, 'chat'), fileDir = path.join(root, 'files');
  const folders = { original: path.join(root, 'original'), other: path.join(root, 'other') };
  for (const directory of Object.values(folders)) fs.mkdirSync(directory, { mode: 0o700 });
  const sourcePath = path.join(folders.original, 'source.test.js'), otherPath = path.join(folders.other, 'source.test.js');
  fs.writeFileSync(sourcePath, CHAT_ORIGIN_FILE_TEXT.historic, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(otherPath, CHAT_ORIGIN_FILE_TEXT.other, { flag: 'wx', mode: 0o600 });
  const catalog = { version: 2, activeAgendaId: 'agenda-default', updatedAt: Date.now(), agendas: {}, meta: {} };
  for (const [kind, boardId] of Object.entries(CHAT_ORIGIN_FILE_BOARDS)) {
    const title = kind === 'original' ? 'QA Original Project' : 'QA Other Project';
    catalog.agendas[boardId] = { version: 1, savedAt: catalog.updatedAt, agenda: { id: boardId, title, memberCardIds: [] }, cards: [], shapes: [] };
    catalog.meta[boardId] = { id: boardId, title, createdAt: catalog.updatedAt, updatedAt: catalog.updatedAt };
  }
  fs.writeFileSync(prefsFile, `// Owned origin-file fixture catalog; prelaunch only.\nuser_pref("egdesk.agendaState.v1", ${JSON.stringify(JSON.stringify(catalog))});\n`, { flag: 'wx', mode: 0o600 });
  const effects = { providerTurns: 0, shellExecutions: 0, nativeProcessSpawns: 0, nativePickerInvocations: 0,
    approvalPosts: 0, uiOriginalWriteAttempts: 0, uiOriginalWrites: 0, gitAttempts: 0, nativeCreateAttempts: 0,
    managedDraftSqlWrites: 0, setupSourceWrites: 2, controlledSourceWrites: 0, profileCatalogWrites: 1, setupPickerGrants: 0 };
  const requests = [], controls = [], frames = [], fakeRpc = [], registrations = [];
  const grants = new Map(Object.entries(folders).map(([kind, folder]) => [`owned-${kind}-${randomUUID()}`, folder]));
  let adapter, mount, original = null, preparedRoom = null, seedStarting = false, disposed = false, closing = null, cached = null, advanced = false;
  const localOwner = `qa-chat-origin:${randomUUID()}`;
  let account = `fake-provider-owner:${randomUUID()}`;
  const store = openChatStore({ dataDir: chatDir, ownerScope: localOwner });
  const database = path.join(chatDir, `chat-${hash(localOwner)}.sqlite`);
  const draftDatabase = path.join(fileDir, 'file-drafts', `${hash('egdesk-local')}.sqlite`);
  const makeMount = () => createEGDeskFileMount({ dataDir: fileDir, port: config.port,
    createNativeAdapter: () => ({ capability: 'unavailable', createFile() { effects.nativeCreateAttempts++; throw fail('QA_NATIVE_CREATE_BLOCKED', 'No native creation'); } }),
    onRootRegistered: value => record(registrations, { ...value }),
    createHttpAdapter: options => {
      adapter = createEGDeskFileHttpAdapter({ ...options,
        resolveRootSelection: async ({ selectionId }) => {
          if (!grants.has(selectionId)) throw fail('QA_PICKER_BLOCKED', 'Only owned one-use setup grants exist');
          const folder = grants.get(selectionId); grants.delete(selectionId); effects.setupPickerGrants++; return folder;
        },
        gitReview: new Proxy({}, { get: () => () => { effects.gitAttempts++; throw fail('QA_GIT_BLOCKED', 'Git is disabled'); } }),
        storeForOwner: async ownerScope => {
          const backing = await openEGDeskManagedDraftStore({ directory: options.draftDirectory, ownerScope });
          return { ...backing, async create(value) { const result = await backing.create(value); effects.managedDraftSqlWrites++; return result; },
            async compareAndSwap(...args) { const result = await backing.compareAndSwap(...args); effects.managedDraftSqlWrites++; return result; } };
        } });
      return adapter;
    } });
  const setupFile = async (operation, body) => {
    const result = await adapter.dispatch({ method: 'POST', pathname: EGDESK_FILE_ENDPOINTS[operation], body });
    assert.equal(result.status, 200, `Real setup ${operation} refused: ${result.body.code}`);
    return result.body.result;
  };
  let chat;
  const projects = {};
  try {
    mount = makeMount();
    for (const [selectionId, folder] of [...grants]) {
      const kind = folder === folders.original ? 'original' : 'other';
      projects[kind] = await setupFile('attachProject', { boardId: CHAT_ORIGIN_FILE_BOARDS[kind], selectionId, title: catalog.meta[CHAT_ORIGIN_FILE_BOARDS[kind]].title });
    }
    chat = new CodexChatRuntime({ store, requireStore: true, getOwnerKey: () => account,
      resolveProjectWorkspace: scope => mount.resolveProjectWorkspace(scope),
      resolveRunProjectOrigin: scope => mount.resolveRunProjectOrigin(scope), verifyFile: async () => null,
      emit: frame => { if (!disposed) { record(frames, structuredClone(frame)); broadcast(frame); } },
      request: async (method, params) => {
        if (disposed) throw fail('QA_FIXTURE_CLOSED', 'Fixture closed', 503);
        if (!['thread/start', 'turn/start'].includes(method)) throw fail('QA_RPC_BLOCKED', 'Only fake acceptance RPC is enabled');
        assert.equal(params.cwd, folders.original, 'The accepted run must use the verified original project');
        if (fakeRpc.some(value => value.method === method)) throw fail('QA_ONE_TURN_ONLY', 'Only one fake provider turn is permitted');
        record(fakeRpc, { method, cwd: params.cwd, ...(method === 'turn/start' ? { conversationId: params.threadId } : {}) });
        return method === 'thread/start' ? { thread: { id: `origin-thread-${randomUUID()}` }, cwd: params.cwd }
          : { turn: { id: `origin-run-${randomUUID()}`, status: 'inProgress', items: [] } };
      }, respond: () => { throw fail('QA_RPC_BLOCKED', 'No provider tools or approval response'); } });
    chat.setConnection(true);
  } catch (cause) { await mount?.close(); store.close(); throw new Error(`Origin fixture setup failed; owned evidence retained at ${root}`, { cause }); }
  const chatHandler = createChatHttpHandler(chat, async () => {});
  const readDb = (file, fn) => {
    const stat = fs.lstatSync(file);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && fs.realpathSync.native(file) === file && isOwnedAndPrivate(file, stat, 0o077));
    const db = new DatabaseSync(file, { readOnly: true }); try { return fn(db); } finally { db.close(); }
  };
  const persisted = () => readDb(database, db => ({ origins: db.prepare('SELECT private_json FROM run_project_origins').all().map(row => JSON.parse(row.private_json)),
    requests: db.prepare('SELECT COUNT(*) AS n FROM requests').get().n, events: db.prepare('SELECT COUNT(*) AS n FROM events').get().n,
    drafts: readDb(draftDatabase, drafts => drafts.prepare('SELECT COUNT(*) AS n FROM drafts').get().n) }));
  function snapshot() {
    if (disposed && cached) return structuredClone({ ...cached, disposed: true, requests });
    const retained = original ? chat.runOutputs.commandOutput(`${original.conversationId}/${original.runId}`, original.itemId) : null;
    return { kind: 'egdesk-chat-origin-file-fixture', fixture: true, profile: manifest.profile, ...config, root, database, draftDatabase,
      folders, sourcePath, otherPath, projects: structuredClone(projects), boards: CHAT_ORIGIN_FILE_BOARDS, preparedRoom, original: structuredClone(original), advanced, disposed,
      effects: { ...effects }, requests: structuredClone(requests), controls: structuredClone(controls), fakeRpc: structuredClone(fakeRpc), registrations: structuredClone(registrations),
      frames: structuredClone(frames), persisted: persisted(), chat: chat.snapshot(),
      retainedOutputSha256: retained ? hash(retained.head + retained.tail) : null, retainedBytes: chat.runOutputs.totalBytes,
      sourceSha256: fs.existsSync(sourcePath) ? hash(fs.readFileSync(sourcePath)) : null,
      otherSha256: hash(fs.readFileSync(otherPath)), nativeUiVerified: false,
      actual: ['Chat HTTP/runtime/store', 'accepted private run origin', 'RunOutputStore', 'File mount/HTTP/project store', 'managed draft SQLite'],
      synthetic: ['owned picker setup grants', 'provider acceptance RPC', 'command completion notification', 'controlled source change'],
      unverified: ['native UI until Main runs the verifier', 'real provider execution'] };
  }
  async function finishAccepted(body, accepted) {
    original = { clientThreadId: body.clientThreadId, conversationId: accepted.conversationId, runId: accepted.runId,
      requestId: accepted.requestId, itemId: 'qa-origin-command', messageId: 'qa-origin-message' };
    const before = persisted();
    assert.equal(before.origins.length, 1, 'Only real accepted chat.send may persist the private origin');
    assert.equal(before.origins[0].project.startCwd, folders.original);
    const command = { id: original.itemId, type: 'commandExecution', status: 'completed', command: 'node --test source.test.js',
      cwd: folders.original, exitCode: 1, durationMs: 12, aggregatedOutput: CHAT_ORIGIN_FILE_OUTPUT };
    const message = { id: original.messageId, type: 'agentMessage', text: 'HISTORIC 명령 출력이 보관되었습니다. 실행 결과에서 현재 파일을 열어 비교하세요.' };
    for (const item of [command, message]) await chat.handleNotification({ method: 'item/completed', params: { threadId: original.conversationId, turnId: original.runId, item } });
    await chat.handleNotification({ method: 'turn/completed', params: { threadId: original.conversationId,
      turn: { id: original.runId, status: 'completed', items: [command, message] } } });
    await chat.queue;
  }
  async function control(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['action', 'clientThreadId'].includes(key))) throw fail('QA_CONTROL_INPUT', 'Bounded fixture action required', 400);
    const action = body.action;
    if (action === 'prepare-room') {
      if (preparedRoom || original || !opaque(body.clientThreadId)) throw fail('QA_PREPARE_ONCE', 'One empty original room is required', 409);
      await setupFile('saveRoomProjectDefault', { roomId: body.clientThreadId, boardId: CHAT_ORIGIN_FILE_BOARDS.original,
        expectedProjectId: projects.original.projectId, expectedRootId: projects.original.rootId });
      preparedRoom = body.clientThreadId;
    } else {
      if (!original || body.clientThreadId !== undefined || controls.some(value => value.action === action)) throw fail('QA_CONTROL_STATE', 'One owned post-acceptance action required', 409);
      if (action === 'advance-current') {
        const stat = fs.lstatSync(sourcePath);
        assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && fs.realpathSync.native(sourcePath) === sourcePath);
        assert.equal(hash(fs.readFileSync(sourcePath)), hash(CHAT_ORIGIN_FILE_TEXT.historic));
        fs.writeFileSync(sourcePath, CHAT_ORIGIN_FILE_TEXT.current); effects.controlledSourceWrites++; advanced = true;
      } else if (action === 'choose-other-default') {
        await setupFile('saveRoomProjectDefault', { roomId: preparedRoom, boardId: CHAT_ORIGIN_FILE_BOARDS.other,
          expectedProjectId: projects.other.projectId, expectedRootId: projects.other.rootId });
      } else if (action === 'missing-file') fs.renameSync(sourcePath, path.join(folders.original, 'source.missing'));
      else if (action === 'disconnect-root') { await mount.close(); mount = makeMount(); }
      else if (action === 'replace-root') {
        fs.renameSync(folders.original, path.join(root, 'original-retired')); fs.mkdirSync(folders.original, { mode: 0o700 });
        fs.writeFileSync(sourcePath, 'REPLACEMENT_ROOT_DO_NOT_READ\n', { flag: 'wx', mode: 0o600 }); effects.controlledSourceWrites++;
      } else if (action === 'account-change') account = `different-fake-owner:${randomUUID()}`;
      else throw fail('QA_CONTROL_INPUT', 'Unknown fixture action', 400);
    }
    record(controls, { action, ...(body.clientThreadId ? { clientThreadId: body.clientThreadId } : {}) });
    return { ok: true, action };
  }
  const replay = (req, body) => Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []),
    { method: req.method, url: req.url, headers: req.headers, socket: req.socket });
  async function handle(req, res, suppliedUrl) {
    let url; try { url = new URL(req.url, config.origin); } catch { return false; }
    const route = url.pathname, controlled = [CHAT_ORIGIN_FILE_STATE, CHAT_ORIGIN_FILE_CONTROL].includes(route);
    if (!controlled && !/^\/(?:chat(?:\/|$)|v1\/files(?:\/|$)|terminal(?:\/|$)|providers?(?:\/|$))/.test(route)) return false;
    let trace, ended = false;
    try {
      if (disposed) throw fail('QA_FIXTURE_CLOSED', 'Fixture closed', 503);
      if (!guardBridgeRequest(req, config.port) || url.origin !== config.origin || suppliedUrl && suppliedUrl.href !== url.href) throw fail('QA_LOOPBACK_REQUIRED', 'Owned loopback request required');
      setBridgeCors(req, res);
      if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return true; }
      if (controlled) {
        if (req.headers['x-egdesk-qa-token'] !== token) throw fail('QA_TOKEN_REQUIRED', 'Fixture token required');
        if (url.search) throw fail('QA_CONTROL_INPUT', 'Control query is not accepted', 400);
        if (route === CHAT_ORIGIN_FILE_STATE && req.method === 'GET') sendJson(res, 200, snapshot());
        else if (route === CHAT_ORIGIN_FILE_CONTROL && req.method === 'POST') sendJson(res, 200, await control(await readJsonBody(req)));
        else throw fail('QA_METHOD', 'Unsupported control method', 405);
        return true;
      }
      trace = record(requests, { sequence: requests.length + 1, method: req.method, path: route, query: Object.fromEntries(url.searchParams), delegated: false, status: null });
      if (route === '/chat/approval' || route === '/chat/user-input') effects.approvalPosts++;
      const operation = Object.keys(EGDESK_FILE_ENDPOINTS).find(name => EGDESK_FILE_ENDPOINTS[name] === route);
      if (ORIGINAL_WRITES.has(operation)) effects.uiOriginalWriteAttempts++;
      const chatRead = req.method === 'GET' && ['/chat/state', '/chat/history', '/chat/history/threads', '/chat/command-output', '/chat/run-changes', '/chat/run-project-origin'].includes(route);
      const fileRead = req.method === 'POST' && FILE_READS.has(operation);
      if (!chatRead && !fileRead && !(req.method === 'POST' && route === '/chat/send')) throw fail('QA_ROUTE_BLOCKED', 'No provider, shell, approval, picker or original write is enabled');
      const body = req.method === 'POST' ? await readJsonBody(req) : null;
      if (body) trace.request = structuredClone(body);
      if (route === '/chat/send') {
        if (original || seedStarting || !preparedRoom || body.clientThreadId !== preparedRoom || body.message !== CHAT_ORIGIN_FILE_SEED || body.profileEnabled === true
            || body.engineId && body.engineId !== 'codex' || body.conversationId || body.stateless || body.projectTarget
            || ['cwd', 'contextSnapshotIds', 'selectedSources', 'attachments', 'agentProfile', 'systemPrompt', 'toolMode', 'executionPolicy'].some(key => body[key] != null && !(Array.isArray(body[key]) && body[key].length === 0))) throw fail('QA_SEED_ONLY', 'Only one ordinary prepared-room send is allowed');
        assertOrdinarySend(body); seedStarting = true;
      }
      const response = { setHeader: (name, value) => res.setHeader(name, value), writeHead(status, headers) { trace.status = status; res.writeHead(status, headers); },
        end(bytes) { ended = true; const packet = JSON.parse(bytes); trace.response = chatRead && ['/chat/state', '/chat/history', '/chat/history/threads'].includes(route)
          ? { protocolVersion: packet.protocolVersion, runIds: packet.runs?.map(run => run.runId) } : packet; res.end(bytes); } };
      trace.delegated = true;
      assert.equal(await (fileRead ? mount.handle(replay(req, body), response, url) : chatHandler(replay(req, body), response, url)), true);
      if (route === '/chat/send') {
        if (trace.status === 202 && trace.response.accepted) await finishAccepted(body, trace.response);
        seedStarting = false;
      }
      return true;
    } catch (cause) {
      if (route === '/chat/send') seedStarting = false;
      if (ended) throw cause;
      const status = cause.httpStatus || 500, code = cause.code || 'QA_ORIGIN_FILE_ERROR';
      if (trace) { trace.status = status; trace.code = code; }
      sendJson(res, status, { code, error: 'Origin File fixture request refused' }); return true;
    }
  }
  return Object.freeze({ handle, snapshot, dispose() {
    if (closing) return closing;
    cached = snapshot(); disposed = true;
    closing = Promise.resolve().then(async () => { await chat.queue; await mount.close(); store.close(); }); return closing;
  } });
}
