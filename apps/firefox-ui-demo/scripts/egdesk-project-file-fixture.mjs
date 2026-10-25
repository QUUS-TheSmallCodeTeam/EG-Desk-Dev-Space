// Opt-in QA adapter. Real File HTTP service + SQLite, synthetic OS picker
// results and shell I/O only. Importing this module starts no service/process.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createEGDeskFileHttpAdapter, EGDESK_FILE_ENDPOINTS, readEGDeskFileBody } from '../helper/egdesk-file-http.mjs';
import { guardBridgeRequest, sendJson } from '../helper/codex-bridge-http.mjs';
import { terminalScriptLine } from '../overlay/resources/EGDeskTerminalState.sys.mjs';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { projectFileFixtureEnabled, qaBridgeConfig } from './egdesk-qa-fixture-isolation.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const require = createRequire(import.meta.url);
const OPERATIONS = new Map(Object.entries(EGDESK_FILE_ENDPOINTS).map(([key, route]) => [route, key]));
const FILE_OPERATIONS = new Set(['openPickerChannel', 'beginPicker', 'completePicker', 'attachProject', 'openProject',
  'readRoomProjectDefault', 'saveRoomProjectDefault',
  'setProjectScripts', 'listDirectory', 'readFile', 'createDraft', 'readDraft', 'updateDraft', 'saveDraft',
  'diffDraft', 'sourceStatus', 'resolvePath']);
const TERMINAL_ROUTES = new Set(['/terminal/shells', '/terminal/spawn', '/terminal/write', '/terminal/read',
  '/terminal/resize', '/terminal/kill']);
const CONTROL_ROUTES = new Set(['/__qa/project-file/state', '/__qa/project-file/config', '/__qa/project-file/picker']);
const error = (code, message, httpStatus = 400) => Object.assign(new Error(message), { code, httpStatus });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const fields = (body, allowed) => {
  if (!plain(body) || Object.keys(body).some(key => !allowed.includes(key))) throw error('QA_INVALID_BODY', 'Unexpected fixture request fields');
};
const jsonBody = req => readEGDeskFileBody(req, 'openPickerChannel');

export function parseProjectTerminalWrite(data, { command, workspace }) {
  if (typeof data !== 'string' || data.length > 8000) throw error('QA_TERMINAL_COMMAND', 'Only the owned project command is allowed');
  const nonce = / ([a-z0-9]{8,32}) "\$\?"\r$/.exec(data)?.[1];
  if (!nonce || data !== terminalScriptLine({ command, cwd: workspace, nonce, shell: 'posix' })) {
    throw error('QA_TERMINAL_COMMAND', 'Terminal write differs from the typed command and owned project folder');
  }
  return nonce;
}

// Validate the response contract consumed by actual terminal-init. The
// synthetic shell never represents a native process or claims a PTY exit.
export function assertProjectTerminalResponse(route, response, sessionId = null) {
  assert.ok(plain(response) && response.syntheticShell === true && response.nativeProcessSpawns === 0);
  if (route === '/terminal/shells') {
    assert.equal(response.platform, 'darwin');
    assert.equal(response.defaultShellId, 'sh');
    assert.deepEqual(response.shells, [{ id: 'sh', label: 'QA synthetic sh', available: true }]);
    assert.equal(response.transport, 'qa-synthetic');
  } else {
    assert.ok(typeof response.sessionId === 'string' && response.sessionId.startsWith('qa-project-terminal-'));
    if (sessionId != null) assert.equal(response.sessionId, sessionId);
    assert.equal(response.ok, true);
    assert.equal(response.exited, false);
    assert.equal(response.exitConfirmed, false);
    assert.ok(['RUNNING', 'STOP_REQUESTED'].includes(response.status));
    if (route === '/terminal/read') assert.equal(typeof response.data, 'string');
    if (route === '/terminal/write') {
      assert.equal(response.accepted, true);
      assert.ok(Number.isSafeInteger(response.bytes) && response.bytes > 0);
    }
    if (route === '/terminal/spawn') {
      assert.equal(response.shellId, 'sh');
      assert.equal(response.usePty, false);
      assert.equal(response.transport, 'qa-synthetic');
    }
  }
  return true;
}

export function createProjectFileFixture({ profile: profilePath, token, env = process.env }) {
  assert.equal(projectFileFixtureEnabled(env), true, 'Explicit project File fixture opt-in is required');
  assert.ok(typeof token === 'string' && token.length >= 16, 'Project fixture control token is required');
  const config = qaBridgeConfig(env), manifest = assertQaFixtureManifest(profilePath);
  assert.ok(manifest.backendDataDir, 'Owned QA backend data directory is required');
  const root = fs.mkdtempSync(path.join(manifest.backendDataDir, 'project-file-qa-'));
  const workspace = path.join(root, 'workspace'), store = path.join(root, 'store');
  fs.mkdirSync(workspace, { mode: 0o700 });
  fs.mkdirSync(store, { mode: 0o700 });
  const outputMarker = `QA_PROJECT_OUTPUT_${randomBytes(12).toString('hex')}`;
  const originalText = `Owned project FileView fixture\n${outputMarker}\n`;
  const originalPath = path.join(workspace, 'qa-project.txt');
  fs.writeFileSync(originalPath, originalText, { flag: 'wx', mode: 0o600 });
  const command = `printf '${outputMarker}\\n'`;
  const owner = `qa-project-file:${randomUUID()}`;
  const databasePath = path.join(store, `projects-${hash(owner)}.sqlite`);
  const adapter = createEGDeskFileHttpAdapter({ draftDirectory: store, projectDirectory: store,
    localOwnerScope: owner, port: config.port });
  const evidence = { fileRequests: [], blockedRoutes: [], pickerResults: [], terminalRequests: [],
    providerTurns: 0, nativePickerInvocations: 0, nativeProcessSpawns: 0 };
  const sessions = new Map(), pendingPickers = new Map(), usedNonces = new Set();
  let pickerResults = [], nextTerminalOutcome = 'complete', writeArmed = true, sequence = 0, disposed = false;
  const record = (list, value) => {
    if (list.length >= 512) throw error('QA_TRACE_LIMIT', 'Bounded project fixture trace is full', 429);
    const item = { sequence: ++sequence, at: Date.now(), ...value };
    list.push(item); return item;
  };
  const persisted = () => {
    if (!fs.existsSync(databasePath)) return { projects: [], bindings: [] };
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try { return { projects: db.prepare('SELECT payload FROM projects ORDER BY id').all().map(row => JSON.parse(row.payload)),
      bindings: db.prepare('SELECT scope, key, projectId, boardId FROM bindings ORDER BY scope, key').all().map(row => ({ ...row })) }; }
    finally { db.close(); }
  };
  const roomDefaults = () => {
    if (!fs.existsSync(databasePath)) return [];
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(databasePath, { readOnly: true });
    try { return db.prepare('SELECT roomId, boardId FROM room_project_inheritance ORDER BY roomId').all().map(row => ({ ...row })); }
    finally { db.close(); }
  };
  const snapshot = () => ({ kind: 'egdesk-project-file-fixture', profile: manifest.profile,
    fixture: true, host: config.host, port: config.port, origin: config.origin,
    root, workspace, store, originalPath, originalText, originalSha256: hash(originalText),
    currentOriginalSha256: hash(fs.readFileSync(originalPath)), command, outputMarker,
    synthetic: { picker: 'OS-directory-result-only', shell: 'terminal-http-io-only' },
    realComponents: ['File HTTP adapter', 'managed drafts', 'project SQLite store'],
    queuedPickerResults: pickerResults.length, nextTerminalOutcome, writeArmed,
    ...structuredClone(evidence), persisted: persisted(), roomDefaults: roomDefaults(),
    sessions: [...sessions.values()].map(({ chunks, ...session }) => ({ ...session, unreadChunks: chunks.length })) });
  const terminalReply = (route, res, packet) => {
    const response = { ...packet, syntheticShell: true, nativeProcessSpawns: 0 };
    assertProjectTerminalResponse(route, response, packet.sessionId);
    sendJson(res, 200, response);
  };
  async function handle(req, res, suppliedUrl) {
    const url = suppliedUrl || new URL(req.url, config.origin);
    const route = url.pathname;
    if (!route.startsWith('/v1/files/') && !CONTROL_ROUTES.has(route) && !TERMINAL_ROUTES.has(route)) return false;
    try {
      if (disposed) throw error('QA_FIXTURE_CLOSED', 'Owned fixture is closed', 503);
      if (url.search || !guardBridgeRequest(req, config.port)) throw error('QA_LOOPBACK_REQUIRED', 'Owned loopback request required', 403);
      if (req.method === 'OPTIONS') {
        // Never advertise cross-origin access to picker results or local files.
        sendJson(res, 403, { error: 'Cross-origin fixture access is disabled', code: 'QA_NATIVE_CHANNEL_REQUIRED' }); return true;
      }
      if (CONTROL_ROUTES.has(route) && route !== '/__qa/project-file/picker') {
        if (req.headers['x-egdesk-qa-token'] !== token) throw error('QA_TOKEN_REQUIRED', 'Fixture control token required', 403);
        if (route.endsWith('/state') && req.method === 'GET') { sendJson(res, 200, snapshot()); return true; }
        if (!route.endsWith('/config') || req.method !== 'POST') throw error('QA_METHOD', 'Invalid control method', 405);
        const body = await jsonBody(req);
        fields(body, ['pickerResults', 'nextTerminalOutcome']);
        if (body.pickerResults !== undefined) {
          if (pickerResults.length || pendingPickers.size) throw error('QA_PICKER_PENDING', 'An owned picker operation is already pending', 409);
          if (!Array.isArray(body.pickerResults) || !body.pickerResults.length || body.pickerResults.length > 3
              || body.pickerResults.some(value => !['cancel', 'select-owned'].includes(value))) throw error('QA_PICKER_RESULT', 'Only cancel or owned directory selections are allowed');
        }
        if (body.nextTerminalOutcome !== undefined) {
          if (!['complete', 'output-loss'].includes(body.nextTerminalOutcome)) throw error('QA_TERMINAL_OUTCOME', 'Unknown synthetic shell outcome');
        }
        if (body.pickerResults !== undefined) pickerResults = [...body.pickerResults];
        if (body.nextTerminalOutcome !== undefined) { nextTerminalOutcome = body.nextTerminalOutcome; writeArmed = true; }
        sendJson(res, 200, { ok: true, queuedPickerResults: pickerResults.length, nextTerminalOutcome }); return true;
      }
      if (route === '/__qa/project-file/picker') {
        if (req.method !== 'POST' || Object.hasOwn(req.headers, 'origin') || Object.hasOwn(req.headers, 'sec-fetch-site')) {
          throw error('QA_NATIVE_CHANNEL_REQUIRED', 'Only the owned privileged picker result boundary may dequeue', 403);
        }
        fields(await jsonBody(req), []);
        const pending = [...pendingPickers.entries()].filter(([, value]) => !value.delivered);
        if (pending.length !== 1 || !pickerResults.length) throw error('QA_PICKER_NOT_ARMED', 'Actual beginPicker and one controlled result are required', 409);
        const [requestId, value] = pending[0];
        const selection = pickerResults.shift() === 'cancel' ? null : workspace;
        value.delivered = true; value.selection = selection;
        record(evidence.pickerResults, { requestId, selection, synthetic: true, nativePickerInvocations: 0 });
        sendJson(res, 200, { kind: 'egdesk-project-file-picker-result', synthetic: true, selection }); return true;
      }
      if (route.startsWith('/v1/files/')) {
        const operation = OPERATIONS.get(route);
        if (req.method !== 'POST' || !FILE_OPERATIONS.has(operation)) {
          record(evidence.blockedRoutes, { route, reason: 'out-of-scope-no-native-process-or-original-write' });
          throw error('QA_FILE_OPERATION_DISABLED', 'This QA fixture does not enable Git, original writes, or unrelated file operations', 403);
        }
        const body = await readEGDeskFileBody(req, operation);
        if (operation === 'completePicker') {
          const pending = pendingPickers.get(body.requestId);
          if (!pending?.delivered || (pending.selection === null ? body.cancelled !== true || body.absolutePath !== undefined
            : body.cancelled === true || body.absolutePath !== workspace)) {
            throw error('QA_PICKER_RESULT_MISMATCH', 'Completion must use the OS result from this actual picker begin', 403);
          }
        }
        const entry = record(evidence.fileRequests, { operation, route, request: structuredClone(body), status: null });
        let status;
        const witness = { writeHead(value, headers) { status = value; res.writeHead(value, headers); }, end(value) {
          const packet = JSON.parse(value);
          entry.status = status;
          // The real ephemeral channel token never enters evidence output.
          entry.response = operation === 'openPickerChannel' && packet.ok === true
            ? { ok: true, result: { expiresAt: packet.result.expiresAt, tokenPresent: typeof packet.result.token === 'string' } }
            : packet;
          if (operation === 'beginPicker' && packet.ok === true) pendingPickers.set(packet.result.requestId, { delivered: false });
          if (operation === 'completePicker' && packet.ok === true) pendingPickers.delete(body.requestId);
          res.end(value);
        } };
        await adapter.handle(req, witness, { url, body }); return true;
      }
      if (route === '/terminal/shells') {
        if (req.method !== 'GET') throw error('QA_METHOD', 'Shell catalog requires GET', 405);
        record(evidence.terminalRequests, { route });
        terminalReply(route, res, { platform: 'darwin', transport: 'qa-synthetic', defaultShellId: 'sh',
          shells: [{ id: 'sh', label: 'QA synthetic sh', available: true }] }); return true;
      }
      if (req.method !== 'POST') throw error('QA_METHOD', 'Terminal operation requires POST', 405);
      const body = await jsonBody(req);
      const entry = route === '/terminal/read' ? { route, request: structuredClone(body), accepted: false }
        : record(evidence.terminalRequests, { route, request: structuredClone(body), accepted: false });
      if (route === '/terminal/spawn') {
        fields(body, ['shellId', 'cols', 'rows']);
        if (body.shellId !== 'sh' || ![body.cols, body.rows].every(value => Number.isSafeInteger(value) && value > 0 && value <= 1000)) throw error('QA_TERMINAL_SIZE', 'Expected bounded synthetic shell dimensions');
        if (sessions.size >= 3) throw error('QA_TERMINAL_LIMIT', 'Only three owned synthetic shells are allowed', 429);
        const sessionId = `qa-project-terminal-${randomUUID()}`;
        sessions.set(sessionId, { sessionId, outcome: null, writes: 0, reads: 0, nonce: null, nonces: [],
          chunks: [], stopRequested: false, readLost: false });
        entry.accepted = true; entry.sessionId = sessionId;
        terminalReply(route, res, { ok: true, sessionId, status: 'RUNNING', shellId: 'sh', shellLabel: 'QA synthetic sh',
          transport: 'qa-synthetic', usePty: false, degraded: false, cols: body.cols, rows: body.rows,
          exited: false, exitConfirmed: false }); return true;
      }
      fields(body, route === '/terminal/write' ? ['sessionId', 'data']
        : route === '/terminal/resize' ? ['sessionId', 'cols', 'rows'] : ['sessionId']);
      const session = sessions.get(body.sessionId);
      if (!session) throw error('UNKNOWN_SESSION', 'Unknown owned synthetic terminal session', 404);
      if (route === '/terminal/write') {
        const nonce = parseProjectTerminalWrite(body.data, { command, workspace });
        if (session.stopRequested || session.readLost || !writeArmed || usedNonces.has(nonce) || usedNonces.size >= 2 ||
            [...sessions.values()].some(value => value.chunks.length)) {
          throw error('QA_DUPLICATE_WRITE', 'Only an explicitly armed new run is accepted; no replay or overlapping command', 409);
        }
        // Darwin's real File runner reuses its idle terminal. Arming controls
        // only the next synthetic shell outcome, not the actual UI write.
        writeArmed = false; usedNonces.add(nonce);
        session.outcome = nextTerminalOutcome; nextTerminalOutcome = 'complete';
        session.writes++; session.nonce = nonce; session.nonces.push(nonce); entry.accepted = true; entry.nonce = nonce;
        if (session.outcome === 'complete') session.chunks.push(`${outputMarker}\r\n[egdesk-run:${nonce}:ex`, 'it=0]\r\n');
        terminalReply(route, res, { ok: true, sessionId: body.sessionId, status: 'RUNNING', accepted: true,
          bytes: Buffer.byteLength(body.data), exited: false, exitConfirmed: false }); return true;
      }
      if (route === '/terminal/read') {
        session.reads++;
        if (session.outcome === 'output-loss' && session.writes) {
          if (!session.readLost) record(evidence.terminalRequests, { ...entry, outputLost: true });
          session.readLost = true; entry.outputLost = true;
          throw error('QA_OUTPUT_LOST', 'Synthetic shell output lost after accepting the original write', 503);
        }
      }
      if (route === '/terminal/resize' && ![body.cols, body.rows].every(value => Number.isSafeInteger(value) && value > 0 && value <= 1000)) throw error('QA_TERMINAL_SIZE', 'Invalid terminal dimensions');
      if (route === '/terminal/kill') session.stopRequested = true;
      entry.accepted = true;
      const data = route === '/terminal/read' ? session.chunks.shift() || '' : '';
      if (route === '/terminal/read' && data) record(evidence.terminalRequests, { ...entry, deliveredData: data });
      terminalReply(route, res, { ok: true, sessionId: body.sessionId,
        status: session.stopRequested ? 'STOP_REQUESTED' : 'RUNNING', stopRequested: session.stopRequested,
        exited: false, exitConfirmed: false, data }); return true;
    } catch (cause) {
      sendJson(res, cause.httpStatus || 400, { ok: false, error: cause.message, code: cause.code || 'QA_PROJECT_FILE_ERROR',
        ...(route.startsWith('/terminal/') ? { syntheticShell: true, nativeProcessSpawns: 0 } : {}) });
      return true;
    }
  }
  return { handle, snapshot, async dispose() { disposed = true; await adapter.close(); },
    info: { projectFileFixture: true, root, workspace, providerTurns: 0, nativePickerInvocations: 0,
      nativeProcessSpawns: 0, synthetic: { picker: 'OS-directory-result-only', shell: 'terminal-http-io-only' } } };
}
