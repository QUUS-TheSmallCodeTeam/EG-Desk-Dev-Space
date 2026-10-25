// Isolated QA sidecar: actual Chat/Task HTTP + workflow SQLite + fake Codex RPC.
// Import/factory never listen, launch a provider, open a browser or touch a user store.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { CodexChatRuntime } from '../helper/codex-chat-runtime.mjs';
import { createChatHttpHandler, guardBridgeRequest, readJsonBody, sendJson, setBridgeCors } from '../helper/codex-bridge-http.mjs';
import { openWorkflowRuntime } from '../helper/egdesk-workflow-runtime.mjs';
import { publicGraph } from '../helper/egdesk-task-http.mjs';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { assertOrdinarySend } from './egdesk-chat-qa-contract.sys.mjs';
import { createPrivateQaTempDirectory, isOwnedAndPrivate } from './egdesk-qa-platform.mjs';

export const TASK_GATE_SEED_MESSAGE = 'EGDESK_QA_TASK_GATE';
export const TASK_GATE_STATE_ROUTE = '/__qa/task-gate/state';
export const TASK_GATE_CONTROL_ROUTE = '/__qa/task-gate/control';
const hash = value => createHash('sha256').update(value).digest('hex');
const failure = (code, message, httpStatus = 403) => Object.assign(new Error(message), { code, httpStatus });
const bounded = (values, item, max = 512) => { if (values.length >= max) throw failure('QA_TRACE_LIMIT', 'Bounded QA evidence is full', 429); values.push(item); return item; };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };

export function taskGateFixtureEnabled(env = process.env) {
  const flag = env.EGDESK_QA_TASK_GATE_FIXTURE;
  if (flag == null || flag === '0') return false;
  if (flag !== '1' || env.EGDESK_QA_FIXTURE_TRANSPORT !== '1' || env.EGDESK_QA_REAL_TURN !== '0') {
    throw failure('QA_TASK_GATE_OPT_IN', 'Task gate QA requires explicit fixture transport and REAL_TURN=0');
  }
  for (const [key, value] of Object.entries(env)) {
    if ((/^EGDESK_QA_.*_FIXTURE$/.test(key) && key !== 'EGDESK_QA_TASK_GATE_FIXTURE'
        || ['EGDESK_QA_BROWSER_NEGATIVE', 'EGDESK_QA_BROWSER_RELAY'].includes(key))
        && value != null && value !== '' && value !== '0') throw failure('QA_TASK_GATE_MODE_CONFLICT', `Task gate QA excludes ${key}`);
  }
  return true;
}

function configuration(env) {
  assert.equal(taskGateFixtureEnabled(env), true, 'Explicit task-gate fixture opt-in is required');
  const port = env.EGDESK_QA_FIXTURE_PORT;
  assert.ok(typeof port === 'string' && /^[1-9][0-9]{0,4}$/.test(port) && Number(port) <= 65535 && Number(port) !== 39218,
    'An explicit nonproduction fixture port is required (this module never listens)');
  return { host: '127.0.0.1', port: Number(port), origin: `http://127.0.0.1:${port}` };
}

const answerTrace = answer => answer && typeof answer === 'object' && !Array.isArray(answer)
  ? { fields: Object.keys(answer).sort(), ...(typeof answer.choice === 'string' ? { choice: answer.choice } : {}),
    ...(typeof answer.text === 'string' ? { textCodePoints: Array.from(answer.text).length, textBytes: Buffer.byteLength(answer.text) } : {}) }
  : { kind: answer === undefined ? 'absent' : answer === null ? 'null' : typeof answer };

// Test-only authority: these modes own no connected/saved project. Null is an
// explicit absence, never an unavailable or "verified" folder. Keep production
// expectation/target shape validation and exact client room binding unchanged.
export function resolveQaEmptyProjectWorkspace(scope) {
  const model = CodexChatRuntime.prototype;
  const expected = model.expectedRoomProject({ ...(scope.expectedRoomProject !== undefined ? { expectedRoomProject: scope.expectedRoomProject } : {}),
    ...(scope.projectTarget !== undefined ? { projectTarget: scope.projectTarget } : {}) });
  if (scope.projectTarget != null) throw failure('PROJECT_TARGET_CHANGED', 'This QA fixture owns no connected project target', 409);
  if (scope.boardId != null || expected && (expected.status !== 'none' || expected.roomId !== scope.roomId)) {
    throw failure('PROJECT_WORKSPACE_CHANGED', 'This QA fixture owns only the exact sending room with no project', 409);
  }
  return null;
}

// Shared by synthetic Chat/Claude transport, which does not instantiate the
// production Chat runtime. Never delete the new field or claim a real project.
export function assertQaEmptyProjectSend(body) {
  if (body.expectedRoomProject === undefined && body.projectTarget === undefined) return null; // unchanged legacy sends
  const model = CodexChatRuntime.prototype, expected = model.expectedRoomProject(body), target = model.projectTarget(body);
  if (expected && (typeof body.clientThreadId !== 'string' || !body.clientThreadId.trim()
      || body.clientThreadId.length > 512 || body.clientThreadId.includes('\0'))) {
    throw failure('INVALID_PROJECT_SCOPE', 'Expected room project requires the actual sending clientThreadId', 400);
  }
  const scope = model.projectScope.call({ resolveProjectWorkspace: resolveQaEmptyProjectWorkspace }, body,
    body.clientThreadId || null, target, expected);
  resolveQaEmptyProjectWorkspace({ ...scope, ...(target ? { projectTarget: target } : {}), ...(expected ? { expectedRoomProject: expected } : {}) });
  return expected;
}

/**
 * await createTaskGateFixture({profile,token,env,broadcast}) -> handle/snapshot/dispose.
 * Singer mounts handle BEFORE common synthetic Chat/Task fallbacks and forwards
 * broadcast(frame) unchanged through its existing event:codex SSE envelope.
 * Await dispose before closing the listener; owned temporary evidence is kept.
 * /chat/send accepts exactly TASK_GATE_SEED_MESSAGE in one ordinary room. Its
 * response and all /tasks/state, /tasks/continue responses are production HTTP.
 * A real plan is seeded/approved through the workflow service, not a fabricated
 * state frame. Only native provider RPC is fake. Original thread/run never move.
 * Token controls only fixture lifecycle/races: replay, refresh, complete-turn,
 * next-question, hold-next, accept-held, release, flush. They never write DOM.
 * accept-held races one REAL internal continue against a held UI request; the
 * UI request then receives the real handler's stale response, not an injected
 * error. Broadcast may be paused only for that bounded race and later flushed.
 */
export async function createTaskGateFixture({ profile, token, env = process.env, broadcast = () => {} } = {}) {
  const config = configuration(env);
  assert.ok(typeof token === 'string' && token.length >= 16, 'An owned fixture token is required');
  if (env.EGDESK_QA_FIXTURE_TOKEN != null) assert.equal(token, env.EGDESK_QA_FIXTURE_TOKEN);
  assert.equal(typeof broadcast, 'function');
  const manifest = assertQaFixtureManifest(profile);
  assert.notEqual(process.platform, 'win32', 'No-process task fixture lane is not enabled on Windows');
  const root = createPrivateQaTempDirectory('egdesk-task-gate-'), dataDir = path.join(root, 'store');
  fs.mkdirSync(dataDir, { mode: 0o700 });
  const database = path.join(dataDir, 'workflow-store', 'workflow.sqlite');
  const owner = `qa-task-gate:${randomUUID()}`, nonce = randomUUID();
  const requests = [], frames = [], turns = [], plans = [], controls = [], queuedFrames = [], projectResolutions = [];
  let runtime = null, original = null, disposed = false, closing = null, cached = null, seedStarting = false;
  let threadCount = 0, held = null, holdNext = false, pauseBroadcast = false;
  const emit = frame => {
    if (disposed) return;
    // Public workflow frames contain descriptors, never written answer text.
    if (['task.graph', 'task.plan', 'task.native', 'workflow.event'].includes(frame.type)) bounded(frames, structuredClone(frame), 2048);
    if (pauseBroadcast) bounded(queuedFrames, structuredClone(frame), 2048);
    else broadcast(frame);
  };
  const chat = new CodexChatRuntime({
    resolveProjectWorkspace: scope => {
      const workspace = resolveQaEmptyProjectWorkspace(scope);
      bounded(projectResolutions, { scope: structuredClone(scope), result: workspace, contract: 'fixture-owned-no-project' });
      return workspace;
    },
    request: async (method, params) => {
      if (disposed) throw failure('QA_FIXTURE_CLOSED', 'Task fixture is closed', 503);
      if (method === 'thread/start') return { thread: { id: `qa-task-thread-${nonce}-${++threadCount}` }, cwd: dataDir };
      if (method === 'thread/resume') return { thread: { id: params.threadId, turns: [] }, cwd: dataDir };
      if (method === 'turn/start') {
        const turnId = `qa-task-turn-${nonce}-${turns.length + 1}`;
        const input = params.input.map(item => item.text || '').join('\n');
        bounded(turns, { turnId, conversationId: params.threadId, completed: false, inputSha256: hash(input),
          hasAnswers: input.includes('<answer ') || input.includes('answers (follow them'), syntheticProvider: true }, 12);
        return { turn: { id: turnId, status: 'inProgress', items: [] } };
      }
      if (method === 'turn/interrupt') return {};
      throw failure('QA_RPC_BLOCKED', 'Only owned fake thread/turn RPC is enabled');
    },
    respond: () => { throw failure('QA_RPC_BLOCKED', 'No provider tool RPC is enabled'); },
    verifyFile: async () => null,
    emit: event => { emit(event); void runtime?.onChatEvent(event); },
  });
  chat.setConnection(true);
  try {
    runtime = await openWorkflowRuntime({ dataDir, chat, port: config.port, broadcast: emit,
      ensureAuth: async () => {}, getOwnerKey: () => owner,
      watch: () => { throw failure('QA_WATCH_BLOCKED', 'No directory watcher is enabled'); } });
    assert.equal(runtime.snapshot().tasks, 'ready', 'Real workflow SQLite must open');
  } catch (error) {
    await runtime?.close();
    throw new Error(`Task fixture initialization failed; owned evidence retained at ${root}`, { cause: error });
  }
  const chatHandler = createChatHttpHandler(chat, async () => {});
  async function finishTurn() {
    const turn = turns.find(value => !value.completed);
    if (!turn) throw failure('QA_NO_TURN', 'No owned fake turn is awaiting completion', 409);
    await chat.handleNotification({ method: 'turn/completed', params: { threadId: turn.conversationId,
      turn: { id: turn.turnId, status: 'completed', items: [] } } });
    await chat.queue; turn.completed = true;
    await runtime.graph.drain();
  }
  async function preparePlan(next = false) {
    if (!original || plans.length >= 2 || next && plans.length !== 1) throw failure('QA_PLAN_LIMIT', 'Only the original question set and one replacement are allowed', 409);
    const tasks = next ? [{ taskId: 'next-note', title: '새 메모 반영', instructions: 'Keep the new answer in the original QA conversation.', dependsOn: [],
      gates: [{ gateId: 'next-memo', kind: 'userAction', label: '새 질문: 덧붙일 말', response: { kind: 'text', maxLength: 8 } }] }]
      : [{ taskId: 'send', title: '보내는 방법 반영', instructions: 'Use the chosen delivery option in the original QA conversation.', dependsOn: [],
        gates: [{ gateId: 'how', kind: 'userAction', label: '어떻게 보낼까요?', response: { kind: 'choice',
          options: [{ id: 'email', label: '메일로' }, { id: 'kakao', label: '카카오톡으로' }] } }] },
      { taskId: 'note', title: '메모 반영', instructions: 'Use the written answer in the original QA conversation.', dependsOn: ['send'],
        gates: [{ gateId: 'memo', kind: 'userAction', label: '덧붙일 말', response: { kind: 'text', maxLength: 20 } }] }];
    const run = chat.snapshot(original.conversationId).runs.find(value => value.runId === original.runId);
    const plan = await runtime.plans.propose({ run, args: { title: next ? '새 질문 확인' : '질문 답변 확인', tasks } });
    const approved = await runtime.plans.approve(plan.planId);
    const graph = approved.graph;
    bounded(plans, { planId: plan.planId, graphId: plan.graphId, boardId: plan.boardId, origin: plan.origin,
      scope: Object.fromEntries(['graphId', 'requestId', 'runId', 'parentTaskId', 'requestedBy'].map(key => [key, graph[key]])),
      questions: tasks.map(task => ({ taskId: task.taskId, title: task.title, gateId: task.gates[0].gateId,
        label: task.gates[0].label, response: task.gates[0].response })) }, 2);
  }
  function persisted() {
    const info = fs.lstatSync(database);
    assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && fs.realpathSync.native(database) === database
      && isOwnedAndPrivate(database, info, 0o077), 'Workflow evidence must remain private and canonical');
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      return { journalCount: db.prepare('SELECT COUNT(*) AS n FROM task_events').get().n,
        records: db.prepare('SELECT kind, COUNT(*) AS count FROM records GROUP BY kind ORDER BY kind').all().map(row => ({ ...row })),
        answers: db.prepare("SELECT record_json FROM records WHERE kind='gate-answer' ORDER BY ord").all().map(row => {
          const record = JSON.parse(row.record_json);
          return { graphId: record.graphId, taskId: record.taskId, gateId: record.gateId, boardId: record.boardId,
            textSha256: hash(record.text), codePoints: Array.from(record.text).length };
        }) };
    } finally { db.close(); }
  }
  function snapshot() {
    if (disposed && cached) return structuredClone({ ...cached, requests, held: null, disposed: true });
    return { kind: 'egdesk-task-gate-fixture', profile: manifest.profile, ...config, root, dataDir, database, disposed,
      original: structuredClone(original), plans: structuredClone(plans), requests: structuredClone(requests),
      frames: structuredClone(frames), controls: structuredClone(controls), fakeProviderTurns: structuredClone(turns),
      projectResolutions: structuredClone(projectResolutions),
      held: held ? { sequence: held.sequence, graphId: held.body.scope?.graphId, taskId: held.body.taskId, gateId: held.body.gateId } : null,
      pauseBroadcast, queuedFrames: queuedFrames.length, persisted: persisted(),
      graphs: plans.map(plan => publicGraph(runtime.graph.getGraph(plan.graphId))),
      providerTurns: 0, nativeProcessSpawns: 0, nativeUiVerified: false,
      actual: ['Chat HTTP/runtime', 'workflow runtime', 'Task HTTP', 'workflow SQLite', 'task.graph frames'],
      synthetic: ['Codex thread/turn RPC', 'plan setup', 'controlled request/SSE delay'],
      unverified: ['native UI', 'real provider execution'] };
  }
  const replay = (req, bytes) => Object.assign(Readable.from(bytes.length ? [bytes] : []),
    { method: req.method, url: req.url, headers: req.headers, socket: req.socket });
  async function control(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'action')) throw failure('QA_CONTROL_INPUT', 'Expected one fixture action', 400);
    const action = body.action;
    if (!['replay', 'refresh', 'complete-turn', 'next-question', 'hold-next', 'accept-held', 'release', 'flush'].includes(action)) throw failure('QA_CONTROL_INPUT', 'Unknown fixture action', 400);
    bounded(controls, { action });
    if (action === 'complete-turn') await finishTurn();
    if (action === 'next-question') await preparePlan(true);
    if (action === 'replay' || action === 'refresh') {
      const frame = frames.findLast(value => value.type === (action === 'refresh' ? 'task.native' : 'task.graph'));
      if (!frame) throw failure('QA_NO_GRAPH', 'No real graph frame to replay', 409);
      emit(structuredClone(frame));
    }
    if (action === 'hold-next') {
      if (held || holdNext) throw failure('QA_HOLD_BUSY', 'A continuation hold is already armed', 409);
      holdNext = true;
    }
    if (action === 'accept-held') {
      if (!held || held.accepted) throw failure('QA_NO_HOLD', 'One held request is required', 409);
      pauseBroadcast = true;
      const request = Object.assign(Readable.from([Buffer.from(JSON.stringify(held.body))]), { method: 'POST', url: '/tasks/continue',
        headers: { host: `127.0.0.1:${config.port}`, 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } });
      let status, packet;
      await runtime.handle(request, { setHeader() {}, writeHead(value) { status = value; }, end(value) { packet = JSON.parse(value); } }, new URL(request.url, config.origin));
      assert.equal(status, 200, 'Race setup must itself be accepted by the real Task handler');
      held.accepted = true;
      controls.at(-1).result = { status, graphId: packet.graph.graphId };
    }
    if (action === 'release') {
      if (!held) throw failure('QA_NO_HOLD', 'No continuation is held', 409);
      held.wait.resolve();
    }
    if (action === 'flush') {
      pauseBroadcast = false;
      for (const frame of queuedFrames.splice(0)) broadcast(frame);
    }
    return { ok: true, action };
  }
  async function handle(req, res, suppliedUrl) {
    let url;
    try { url = new URL(req.url, config.origin); } catch { return false; }
    const route = url.pathname, controlRoute = route === TASK_GATE_STATE_ROUTE || route === TASK_GATE_CONTROL_ROUTE;
    const chatRoute = ['/chat/send', '/chat/state', '/chat/resume', '/chat/interrupt'].includes(route);
    const taskRoute = route.startsWith('/tasks/') || route === '/task-sources';
    if (!controlRoute && !chatRoute && !taskRoute && !/^\/(?:terminal|providers?)(?:\/|$)/.test(route)) return false;
    let ended = false, trace = null;
    try {
      if (disposed) throw failure('QA_FIXTURE_CLOSED', 'Task fixture is closed', 503);
      if (!guardBridgeRequest(req, config.port) || url.origin !== config.origin || suppliedUrl && suppliedUrl.href !== url.href) throw failure('QA_LOOPBACK_REQUIRED', 'Owned loopback request required');
      setBridgeCors(req, res);
      if (req.method === 'OPTIONS') { sendJson(res, 204, {}); return true; }
      if (controlRoute) {
        if (req.headers['x-egdesk-qa-token'] !== token) throw failure('QA_TOKEN_REQUIRED', 'Fixture control token required');
        if (url.search) throw failure('QA_CONTROL_INPUT', 'Control routes take no query', 400);
        if (route === TASK_GATE_STATE_ROUTE && req.method === 'GET') sendJson(res, 200, snapshot());
        else if (route === TASK_GATE_CONTROL_ROUTE && req.method === 'POST') sendJson(res, 200, await control(await readJsonBody(req)));
        else throw failure('QA_METHOD', 'Unsupported fixture control method', 405);
        return true;
      }
      const allowed = req.method === 'GET' && ['/chat/state', '/tasks/state', '/tasks/plans'].includes(route)
        || req.method === 'POST' && ['/chat/send', '/chat/resume', '/chat/interrupt', '/tasks/continue'].includes(route);
      if (!allowed) throw failure('QA_TASK_GATE_ROUTE_BLOCKED', 'Only owned Chat and Task state/continue are enabled');
      trace = bounded(requests, { sequence: requests.length + 1, method: req.method, path: route, query: url.search, delegated: false, status: null });
      let bytes = Buffer.alloc(0), body;
      if (req.method === 'POST') {
        const chunks = []; let length = 0;
        for await (const part of req) { const chunk = Buffer.from(part); length += chunk.length; if (length > 65536) throw failure('QA_BODY_LIMIT', 'Bounded fixture body exceeded', 413); chunks.push(chunk); }
        bytes = Buffer.concat(chunks);
        try { body = JSON.parse(bytes.toString('utf8')); } catch { /* the production parser owns invalid JSON */ }
      }
      if (route === '/chat/send') {
        if (original || seedStarting || body?.message !== TASK_GATE_SEED_MESSAGE) throw failure('QA_SEED_ONLY', 'Only one explicit original-room QA seed is accepted');
        if (body.profileEnabled === true || body.engineId && body.engineId !== 'codex'
            || ['cwd', 'contextSnapshotIds', 'selectedSources', 'attachments', 'agentProfile', 'systemPrompt', 'toolMode'].some(key => body[key] != null && !(Array.isArray(body[key]) && !body[key].length))) {
          throw failure('QA_SEED_ONLY', 'Only an ordinary context-free Codex fixture room is permitted');
        }
        assertOrdinarySend(body); seedStarting = true;
        trace.clientThreadId = body.clientThreadId;
      }
      if (route === '/tasks/continue') {
        trace.request = { graphId: body?.scope?.graphId, taskId: body?.taskId, gateId: body?.gateId, boardId: body?.boardId, answer: answerTrace(body?.answer) };
        if (holdNext) {
          holdNext = false; const wait = deferred();
          held = { sequence: trace.sequence, body, wait, accepted: false };
          // A hold is bounded even if a verifier disappears. Expiry releases
          // the real request; it does not invent a cancellation receipt.
          const timer = setTimeout(() => wait.resolve(), 60000); timer.unref?.();
          try { await wait.promise; } finally { clearTimeout(timer); held = null; }
          if (disposed) throw failure('QA_FIXTURE_CLOSED', 'Fixture closed before dispatch', 503);
        }
      }
      const response = { setHeader(name, value) { return res.setHeader(name, value); },
        writeHead(status, headers) { trace.status = status; return res.writeHead(status, headers); },
        end(value) { ended = true; trace.response = JSON.parse(value); return res.end(value); } };
      trace.delegated = true;
      const input = replay(req, bytes);
      assert.equal(await (chatRoute ? chatHandler : runtime.handle)(input, response, url), true);
      if (route === '/chat/send') {
        if (trace.status === 202 && trace.response.accepted) {
          original = { clientThreadId: body.clientThreadId, conversationId: trace.response.conversationId,
            runId: trace.response.runId, requestId: trace.response.requestId };
          await preparePlan(); await finishTurn();
        }
        seedStarting = false;
      }
      return true;
    } catch (cause) {
      if (route === '/chat/send') seedStarting = false;
      if (ended) throw cause; // Never fabricate a second response after a real receipt.
      const status = cause.httpStatus || 500, code = cause.code || 'QA_TASK_GATE_ERROR';
      if (trace) { trace.status = status; trace.code = code; }
      sendJson(res, status, { code, error: 'Task gate fixture request was refused' });
      return true;
    }
  }
  return Object.freeze({ handle, snapshot, dispose() {
    if (closing) return closing;
    cached = snapshot(); disposed = true; held?.wait.resolve();
    closing = runtime.close();
    return closing;
  } });
}
