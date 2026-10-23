#!/usr/bin/env node
// Developer-only HTTP/SSE fixture. Never imported by the shipped bridge.
// Main must explicitly start it before the launcher so :39218 is occupied.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { assertOrdinarySend } from './egdesk-chat-qa-contract.sys.mjs';
import { createQaContextFixture } from './egdesk-context-qa-fixture.mjs';
import { observeQaFixtureFile } from './egdesk-context-qa-contract.mjs';

const PORT = 39218;
const HOST = '127.0.0.1';

// Importing this factory starts no service. Unit tests invoke the handler with
// in-memory requests; only the explicit CLI below is allowed to listen.
export function createQaFixtureTransport({ profile: profilePath, token }) {
if (typeof token !== 'string' || token.length < 16) throw new Error('Fixture token must contain at least 16 characters');
const fixture = assertQaFixtureManifest(profilePath);
const profile = fixture.profile;
const artifactRoot = fixture.root;
const artifactPath = fixture.artifactPath;
const context = createQaContextFixture(profile);
let failNextCapture = false;
let holdNextCapture = false;
const heldCaptures = [];

const streamId = randomUUID();
let seq = 0;
let turnCounter = 0;
let connection = 'ready';
let authLookupFails = false;
let authLoggedIn = true;
let accountVariant = 'a';
let holdResume = false;
let partialHistory = false;
let terminalMode = null;
const heldResumes = [];
const fixtureTerminals = new Map();
const clients = new Set();
const runs = new Map();
const failedStarts = new Map();
const observed = { sends: [], interrupts: [], resumes: [], approvals: [], authWrites: [], events: [], reconnects: 0, replays: 0, heldResumes: 0, releasedResumes: 0, contextCaptureFailures: 0 };

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type, X-EGDESK-QA-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' });
  res.end(JSON.stringify(value));
}

function settleStopHold(run, state) {
  const hold = run.stopAckHold;
  clearTimeout(hold.timer);
  const response = hold.response;
  response?.off?.('close', hold.onClose);
  hold.response = null;
  hold.state = state;
  return response;
}

function expireStopHold(run, state = 'expired') {
  const response = settleStopHold(run, state);
  if (response && !response.destroyed && !response.writableEnded) {
    json(response, 408, { accepted: false, stopRequested: false, code: 'QA_STOP_HOLD_EXPIRED' });
  }
}

function acknowledgeStop(run, response) {
  run.stopRequested = true;
  run.fixtureStage = 'stop-requested';
  envelope(run, 'run.stop_requested');
  json(response, 202, { accepted: true, stopRequested: true });
}

async function bodyJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 64 * 1024) throw new Error('Fixture request body too large');
  }
  return raw ? JSON.parse(raw) : {};
}

function envelope(run, event, details = {}, itemId) {
  const value = { type: 'chat.event', v: 2, provider: 'codex', event,
    streamId, seq: ++seq, ts: Date.now(), requestId: run.requestId,
    clientThreadId: run.clientThreadId, conversationId: run.conversationId,
    runId: run.runId, answerId: run.answerId,
    ...(itemId ? { itemId } : {}), details };
  observed.events.push(value);
  const wire = `event: codex\ndata: ${JSON.stringify(value)}\n\n`;
  for (const client of clients) {
    try { client.write(wire); } catch { clients.delete(client); }
  }
  return value;
}

function authSnapshot() {
  return { isLoggedIn: authLoggedIn, loginInProgress: false, statusText: 'QA fixture only',
    requiresOpenaiAuth: !authLoggedIn, accountId: 'chatgpt', authMode: 'chatgpt',
    accountEmail: `qa-account-${accountVariant}@egdesk.invalid` };
}

function broadcastFixtureEvent(event) {
  for (const client of clients) client.write(`event: codex\ndata: ${JSON.stringify(event)}\n\n`);
}

function runState(run) {
  return { runId: run.runId, answerId: run.answerId, status: run.status,
    stopRequested: run.stopRequested, messages: [...run.messages.values()],
    activities: [...run.activities.values()], artifacts: [...run.artifacts],
    pendingApprovals: [...run.pendingApprovals], error: run.error,
    ...(run.contextCaptures ? { contextCaptures: run.contextCaptures, contextEvents: run.contextEvents || [], briefing: run.briefing || null } : {}) };
}

function contextPhase(run, phase) {
  if (run.scenario !== 'CONTEXT') throw new Error('Not a scoped context fixture run');
  if (phase === 'read' && run.fixtureStage === 'context-bound') {
    run.contextPackets = [];
    for (const capture of run.contextCaptures) {
      const details = { sourceId: capture.sourceId, toolName: 'egdesk_read_source', fixtureOnly: true };
      envelope(run, 'context.read.started', details);
      const packet = context.deliver(capture.sourceId, run, run.fixtureOwner);
      run.contextPackets.push(packet);
      const complete = { ...details, packetId: packet.packetId, hash: packet.hash };
      envelope(run, 'context.read.completed', complete);
      run.contextEvents.push({ event: 'context.read.completed', details: complete });
    }
    run.fixtureStage = 'context-read';
    return;
  }
  if (phase === 'briefing' && run.fixtureStage === 'context-read') {
    const messageId = `${run.runId}-message`;
    const text = 'QA fixture answer: captured inputs remain separate from the changed live original.';
    run.messages.set(messageId, { id: messageId, role: 'assistant', status: 'completed', text });
    envelope(run, 'message.started', { messageId, phase: 'answer' }, messageId);
    envelope(run, 'message.completed', { messageId, text, phase: 'answer' }, messageId);
    run.briefing = { id: `qa-briefing-${run.runId}`, title: 'QA captured-input briefing',
      conversationId: run.conversationId, runId: run.runId, answerId: run.answerId,
      createdAt: Date.now(), presentationStatus: 'proposed', steps: run.contextCaptures.slice(0, 2).map((capture, index) => ({
      id: `qa-step-${index + 1}`, text: `Captured input ${index + 1}; original version`,
      target: { sourceId: capture.sourceId, hash: capture.hash, range: index === 1 && capture.shape.lineCount >= 240
        ? { startLine: 201, endLine: 240 } : { startLine: 1, endLine: Math.min(20, capture.shape.lineCount) } },
      fallback: 'Preserved input is unavailable; do not replace it with a live source.',
    })) };
    envelope(run, 'briefing.published', { briefing: run.briefing });
    run.status = 'completed';
    envelope(run, 'run.completed', { status: 'completed' });
    run.fixtureStage = 'terminal';
    return;
  }
  throw new Error('Context release phase does not match current fixture state');
}

function conversationState(conversationId) {
  return { streamId, seq, connection, conversationId,
    runs: [...runs.values()].filter((run) => run.conversationId === conversationId).map(runState),
    truncated: partialHistory, historyComplete: !partialHistory };
}

function completeScenario(run) {
  const activityId = `${run.runId}-activity`;
  const messageId = `${run.runId}-message`;
  const activity = { id: activityId, kind: 'commandExecution', status: 'inProgress',
    title: 'QA fixture: observe a harmless local reference', sourceRefs: [] };
  run.activities.set(activityId, activity);
  envelope(run, 'activity.started', activity, activityId);
  run.messages.set(messageId, { id: messageId, role: 'assistant', status: 'streaming', text: '' });
  envelope(run, 'message.started', { messageId, phase: 'answer' }, messageId);
  const chunks = [
    'Fixture reply begins.\n',
    ...Array.from({ length: 35 }, (_, index) => `Rendered scroll line ${index + 1}.\n`),
    'Fixture reply ends.\n',
  ];
  let index = 0;
  const next = () => {
    if (index < chunks.length) {
      const delta = chunks[index++];
      run.messages.get(messageId).text += delta;
      envelope(run, 'message.delta', { messageId, delta, phase: 'answer' }, messageId);
      setTimeout(next, 14);
      return;
    }
    run.fixtureStage = 'streaming-visible';
    run.releaseMessage = () => {
      const message = run.messages.get(messageId);
      message.status = 'completed';
      envelope(run, 'message.completed', { messageId, text: message.text, phase: 'answer' }, messageId);
      activity.status = 'completed';
      envelope(run, 'activity.completed', activity, activityId);
      const artifact = { id: `${run.runId}-artifact`, type: 'file', target: { path: artifactPath },
        label: path.basename(artifactPath), status: 'available', conversationId: run.conversationId,
        runId: run.runId, answerId: run.answerId, sourceItemId: messageId,
        relation: 'referenced', verifiedAt: new Date().toISOString() };
      assertQaFixtureManifest(profile);
      if (!fs.statSync(artifactPath).isFile()) throw new Error('Fixture artifact disappeared');
      run.artifacts.push(artifact);
      envelope(run, 'artifact.available', { artifact }, messageId);
      run.fixtureStage = 'message-completed';
    };
  };
  setTimeout(next, 15);
}

function textOnlyScenario(run) {
  const messageId = `${run.runId}-message`;
  const text = 'Ordinary text mentions /tmp/not-a-file but references no artifact.';
  run.messages.set(messageId, { id: messageId, role: 'assistant', status: 'streaming', text: '' });
  envelope(run, 'message.started', { messageId, phase: 'answer' }, messageId);
  setTimeout(() => {
    run.messages.get(messageId).text = text;
    envelope(run, 'message.delta', { messageId, delta: text, phase: 'answer' }, messageId);
    run.messages.get(messageId).status = 'completed';
    envelope(run, 'message.completed', { messageId, text, phase: 'answer' }, messageId);
    run.status = 'completed';
    envelope(run, 'run.completed', { status: 'completed' });
  }, 30);
}

function stopScenario(run) {
  const activityId = `${run.runId}-activity`;
  const messageId = `${run.runId}-message`;
  const activity = { id: activityId, kind: 'mcpToolCall', status: 'inProgress',
    title: 'QA fixture: waiting for explicit stop', sourceRefs: [] };
  run.activities.set(activityId, activity);
  run.messages.set(messageId, { id: messageId, role: 'assistant', status: 'streaming', text: 'Waiting for stop.' });
  envelope(run, 'activity.started', activity, activityId);
  envelope(run, 'message.started', { messageId, phase: 'answer' }, messageId);
  envelope(run, 'message.delta', { messageId, delta: 'Waiting for stop.', phase: 'answer' }, messageId);
}

function approvalScenario(run) {
  const approval = { approvalId: `${run.runId}-approval`, kind: 'fileChange', status: 'pending',
    choices: ['decline', 'cancel'], itemId: `${run.runId}-proposed-file`, reason: 'QA proposed file, never created',
    cwd: artifactRoot, paths: [path.join(artifactRoot, 'proposed-not-created.txt')] };
  run.pendingApprovals.push(approval);
  envelope(run, 'approval.required', { approval }, approval.itemId);
}

function unavailableScenario(run) {
  setTimeout(() => {
    connection = 'offline';
    run.status = 'failed';
    run.error = { code: 'RUNTIME_LOST', message: 'QA fixture runtime loss' };
    envelope(run, 'run.unavailable', { error: run.error });
  }, 200);
}

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`);
    if (url.origin !== `http://${HOST}:${PORT}`) return json(res, 400, { error: 'Fixture accepts only its loopback origin' });
    const browserDocument = url.pathname.match(/^\/__qa\/browser-document\/([0-9a-f]{10})$/);
    if (req.method === 'GET' && browserDocument) {
      const file = path.join(artifactRoot, `context-browser-${browserDocument[1]}.html`);
      observeQaFixtureFile(profile, file);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(fs.readFileSync(file, 'utf8'));
      return;
    }
    if (req.method === 'OPTIONS') {
      const paths = ['/health', '/v1/state', '/auth/status', '/events', '/chat/state', '/chat/resume',
        '/chat/send', '/chat/interrupt', '/chat/approval', '/__qa/state', '/__qa/release',
        '/__qa/auth-refresh', '/__qa/reconnect', '/__qa/replay', '/auth/signout', '/__qa/hold-resume',
        '/__qa/release-resume', '/__qa/history', '/__qa/delta', '/__qa/auth-diagnostics', '/__qa/runtime-ready',
        '/__qa/account-change', '/__qa/terminal-mode', '/terminal/spawn', '/terminal/read', '/terminal/kill', '/terminal/resize',
        '/context/captures', '/__qa/context-config', '/__qa/context-release', '/__qa/hold-stop', '/__qa/release-stop'];
      return json(res, paths.includes(url.pathname) || /^\/context\/captures\/[\da-f-]{36}$/i.test(url.pathname) ? 204 : 404, {});
    }
    if (req.method === 'GET' && url.pathname === '/__qa/state') {
      if (req.headers['x-egdesk-qa-token'] !== token) return json(res, 403, { error: 'Fixture token required' });
      return json(res, 200, { fixture: true, profile, artifactRoot, artifactPath,
        streamId, seq, clients: clients.size, observed, context: context.stats, pendingContextCaptures: heldCaptures.length,
        runs: [...runs.values()].map((run) => ({ ...runState(run), conversationId: run.conversationId,
          requestId: run.requestId, clientThreadId: run.clientThreadId, fixtureStage: run.fixtureStage || null,
          stopAckHold: run.stopAckHold ? { state: run.stopAckHold.state, deadlineAt: run.stopAckHold.deadlineAt } : null })) });
    }
    if (req.method === 'POST' && ['/__qa/hold-stop', '/__qa/release-stop'].includes(url.pathname)) {
      if (req.headers['x-egdesk-qa-token'] !== token) return json(res, 403, { error: 'Fixture token required' });
      assertQaFixtureManifest(profile);
      const body = await bodyJson(req);
      const run = runs.get(body.runId);
      if (!run || run.scenario !== 'STOP' || run.conversationId !== body.conversationId || run.requestId !== body.requestId) {
        return json(res, 404, { error: 'Exact STOP fixture run/request required' });
      }
      if (url.pathname === '/__qa/hold-stop') {
        const now = Date.now();
        if (!Number.isSafeInteger(body.deadlineAt) || body.deadlineAt <= now || body.deadlineAt > now + 15000) {
          return json(res, 400, { error: 'deadlineAt must be an epoch millisecond deadline within 15 seconds' });
        }
        if (run.stopAckHold || run.stopRequested || run.status !== 'running') return json(res, 409, { error: 'Stop hold already used or run is not running' });
        run.stopAckHold = { state: 'armed', deadlineAt: body.deadlineAt, response: null };
        run.stopAckHold.timer = setTimeout(() => expireStopHold(run), body.deadlineAt - now);
        run.stopAckHold.timer.unref?.();
        return json(res, 200, { fixtureOnly: true, state: 'armed', deadlineAt: body.deadlineAt });
      }
      const hold = run.stopAckHold;
      if (hold && ['armed', 'pending'].includes(hold.state) && Date.now() >= hold.deadlineAt) expireStopHold(run);
      if (hold?.state !== 'pending' || !hold.response || hold.response.destroyed || run.status !== 'running') {
        return json(res, 409, { error: 'No pending Stop ACK for that exact fixture run/request' });
      }
      acknowledgeStop(run, settleStopHold(run, 'released'));
      return json(res, 200, { fixtureOnly: true, state: 'released', stopRequested: true, terminal: false });
    }
    if (req.method === 'POST' && ['/__qa/context-config', '/__qa/context-release'].includes(url.pathname)) {
      if (req.headers['x-egdesk-qa-token'] !== token) return json(res, 403, { error: 'Fixture token required' });
      const body = await bodyJson(req);
      if (url.pathname === '/__qa/context-config') {
        failNextCapture = body.failNextCapture === true;
        holdNextCapture = body.holdNextCapture === true;
      }
      else if (body.phase === 'capture') {
        const index = heldCaptures.findIndex(item => item.clientThreadId === body.clientThreadId);
        if (index < 0) return json(res, 409, { error: 'No held capture for that fixture wire thread' });
        const pending = heldCaptures.splice(index, 1)[0];
        json(pending.res, 200, pending.result);
      }
      else {
        const run = runs.get(body.runId);
        if (!run) return json(res, 404, { error: 'Unknown fixture run' });
        contextPhase(run, body.phase);
      }
      return json(res, 200, { ok: true, fixtureOnly: true });
    }
    if (req.method === 'POST' && url.pathname === '/context/captures') {
      if (!authLoggedIn) return json(res, 403, { error: 'Fixture account is signed out' });
      if (failNextCapture) { failNextCapture = false; observed.contextCaptureFailures++; return json(res, 503, { code: 'QA_CAPTURE_FAILED', error: 'Explicit fixture capture failure' }); }
      const body = await bodyJson(req);
      const result = context.captureBatch(body, accountVariant);
      if (holdNextCapture) {
        holdNextCapture = false;
        heldCaptures.push({ res, result, clientThreadId: body.clientThreadId });
        return;
      }
      return json(res, 200, result);
    }
    const captureRoute = url.pathname.match(/^\/context\/captures\/([\da-f-]{36})$/i);
    if (req.method === 'GET' && captureRoute) {
      if (!authLoggedIn) return json(res, 403, { error: 'Fixture account is signed out' });
      if ([...url.searchParams.keys()].some(key => !['startLine', 'endLine', 'packetId'].includes(key))) return json(res, 400, { error: 'Unknown inspector query field' });
      const options = Object.fromEntries(['startLine', 'endLine'].filter(key => url.searchParams.has(key)).map(key => [key, Number(url.searchParams.get(key))]));
      if (url.searchParams.has('packetId')) options.packetId = url.searchParams.get('packetId');
      return json(res, 200, context.inspect(captureRoute[1], options, accountVariant));
    }
    if (req.method === 'POST' && url.pathname === '/__qa/release') {
      if (req.headers['x-egdesk-qa-token'] !== token) return json(res, 403, { error: 'Fixture token required' });
      const body = await bodyJson(req);
      const run = runs.get(body.runId);
      if (!run) return json(res, 404, { error: 'Unknown fixture run' });
      if (body.phase === 'message' && run.fixtureStage === 'streaming-visible') run.releaseMessage();
      else if (body.phase === 'approval' && run.fixtureStage === 'approval-reply-sent') {
        const approvalId = run.pendingApprovals[0].approvalId;
        run.pendingApprovals = [];
        envelope(run, 'approval.resolved', { approvalId });
        run.fixtureStage = 'approval-resolved';
      } else if (body.phase === 'run' && ['message-completed', 'approval-resolved', 'stop-requested'].includes(run.fixtureStage)) {
        run.status = run.stopRequested || run.approvalDecision === 'cancel' ? 'interrupted' : 'completed';
        for (const message of run.messages.values()) if (message.status === 'streaming') message.status = 'partial';
        envelope(run, 'run.completed', { status: run.status });
        run.fixtureStage = 'terminal';
      } else return json(res, 409, { error: 'Fixture release phase does not match current state' });
      return json(res, 200, { ok: true, fixtureStage: run.fixtureStage });
    }
    if (req.method === 'POST' && url.pathname === '/__qa/auth-refresh') {
      if (req.headers['x-egdesk-qa-token'] !== token) return json(res, 403, { error: 'Fixture token required' });
      authLookupFails = (await bodyJson(req)).fail === true;
      return json(res, 200, { authLookupFails });
    }
    if (req.method === 'POST' && ['/__qa/hold-resume', '/__qa/release-resume', '/__qa/history', '/__qa/delta',
      '/__qa/auth-diagnostics', '/__qa/runtime-ready', '/__qa/account-change', '/__qa/terminal-mode'].includes(url.pathname)) {
      if (req.headers['x-egdesk-qa-token'] !== token) return json(res, 403, { error: 'Fixture token required' });
      const body = await bodyJson(req);
      if (url.pathname === '/__qa/hold-resume') holdResume = body.hold === true;
      if (url.pathname === '/__qa/release-resume') {
        holdResume = false;
        for (const pending of heldResumes.splice(0)) {
          observed.releasedResumes++;
          if (!pending.res.destroyed) json(pending.res, 200, pending.snapshot);
        }
      }
      if (url.pathname === '/__qa/history') partialHistory = body.partial === true;
      if (url.pathname === '/__qa/runtime-ready') {
        connection = 'ready';
        for (const client of clients) client.write('event: ready\ndata: {"ok":true}\n\n');
      }
      if (url.pathname === '/__qa/auth-diagnostics') broadcastFixtureEvent({ type: 'auth.lifecycle', v: 1,
        provider: 'codex', phase: 'failed', details: { error: 'QA fixture diagnostic for logout controls' } });
      if (url.pathname === '/__qa/account-change') {
        if (!['a', 'b'].includes(body.variant)) return json(res, 400, { error: 'Only synthetic account variants a/b are permitted' });
        accountVariant = body.variant;
        broadcastFixtureEvent({ type: 'auth.status', v: 1, provider: 'codex', status: authSnapshot() });
      }
      if (url.pathname === '/__qa/delta') {
        const run = runs.get(body.runId);
        const message = run && [...run.messages.values()].find(item => item.role === 'assistant' && item.status === 'streaming');
        if (!message || typeof body.delta !== 'string') return json(res, 409, { error: 'No active fixture message' });
        message.text += body.delta;
        envelope(run, 'message.delta', { messageId: message.id, delta: body.delta, phase: 'answer' }, message.id);
      }
      if (url.pathname === '/__qa/terminal-mode') {
        if (body.mode !== 'unknown') return json(res, 400, { error: 'Only unknown-exit Terminal fixtures are supported' });
        terminalMode = 'unknown';
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'POST' && ['/__qa/reconnect', '/__qa/replay'].includes(url.pathname)) {
      if (req.headers['x-egdesk-qa-token'] !== token) return json(res, 403, { error: 'Fixture token required' });
      if (url.pathname === '/__qa/reconnect') {
        observed.reconnects++;
        for (const client of clients) client.end();
        clients.clear();
      } else {
        observed.replays++;
        for (const event of observed.events) {
          for (const client of clients) client.write(`event: codex\ndata: ${JSON.stringify(event)}\n\n`);
        }
      }
      return json(res, 200, { ok: true });
    }
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, fixture: true, appServerReady: true });
    if (req.method === 'GET' && (url.pathname === '/v1/state' || url.pathname === '/auth/status')) {
      if (authLookupFails) return json(res, 503, { error: 'QA account refresh temporarily unavailable' });
      const auth = authSnapshot();
      return json(res, 200, url.pathname === '/auth/status' ? auth : {
        protocolVersion: 2, provider: 'codex', appServerReady: true, auth,
        capabilities: { auth: ['status'], chat: ['send', 'stream', 'interrupt', 'resume'] },
      });
    }
    if (req.method === 'POST' && url.pathname === '/auth/signout') {
      // Explicit fixture implementation only. There is no real bridge/client to
      // forward to, and this module never imports a Codex runtime or credentials.
      authLoggedIn = false;
      observed.authWrites.push({ route: '/auth/signout', at: Date.now() });
      const status = authSnapshot();
      broadcastFixtureEvent({ type: 'auth.status', v: 1, provider: 'codex', status });
      return json(res, 200, status);
    }
    if (req.method === 'GET' && url.pathname === '/events') {
      if (url.searchParams.get('chatProtocol') !== '2') return json(res, 400, { error: 'v2 fixture only' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
        Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' });
      res.write('event: ready\ndata: {"ok":true}\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/chat/state') {
      return json(res, 200, conversationState(url.searchParams.get('conversationId') || ''));
    }
    if (req.method === 'POST' && url.pathname === '/chat/resume') {
      const body = await bodyJson(req);
      observed.resumes.push({ conversationId: body.conversationId, clientThreadId: body.clientThreadId || null });
      const snapshot = conversationState(body.conversationId || '');
      if (holdResume) { observed.heldResumes++; heldResumes.push({ res, snapshot }); return; }
      return json(res, 200, snapshot);
    }
    if (req.method === 'POST' && url.pathname === '/chat/send') {
      const body = await bodyJson(req);
      assertOrdinarySend(body);
      if (!/^EGDESK_QA_(COMPLETE|TEXT_ONLY|STOP|APPROVAL|LOST|START_FAIL|REJECT|AMBIGUOUS|CONTEXT)\b/.test(body.message)) {
        return json(res, 400, { error: 'Fixture accepts only explicit EGDESK_QA_* messages' });
      }
      let scenario = body.message.match(/^EGDESK_QA_(COMPLETE|TEXT_ONLY|STOP|APPROVAL|LOST|START_FAIL|REJECT|AMBIGUOUS|CONTEXT)\b/)[1];
      if (scenario === 'REJECT' || scenario === 'AMBIGUOUS') {
        observed.sends.push({ ...body, scenario, outcome: scenario === 'REJECT' ? 'definite-rejection' : 'ambiguous-no-run' });
        if (scenario === 'REJECT') return json(res, 503, { accepted: false, code: 'BRIDGE_OFFLINE', error: 'QA definite rejection', conversationId: body.conversationId || null });
        res.destroy();
        return;
      }
      if (scenario === 'START_FAIL') {
        let createdConversationId = failedStarts.get(body.clientThreadId);
        if (!createdConversationId) {
          createdConversationId = `qa-started-conversation-${++turnCounter}`;
          failedStarts.set(body.clientThreadId, createdConversationId);
          observed.sends.push({ ...body, scenario, createdConversationId, outcome: 'turn-start-rejected' });
          return json(res, 500, { accepted: false, code: 'TURN_START_FAILED',
            error: 'QA thread started but the turn was rejected', conversationId: createdConversationId, requestId: body.requestId });
        }
        if (body.conversationId !== createdConversationId) {
          return json(res, 409, { accepted: false, code: 'CONVERSATION_REQUIRED', error: 'Retry must use the known native conversation', conversationId: createdConversationId });
        }
        scenario = 'TEXT_ONLY';
      }
      const number = ++turnCounter;
      const conversationId = body.conversationId || `qa-conversation-${number}`;
      const requestId = body.requestId || `qa-request-${number}`;
      const runId = `qa-run-${number}`;
      const run = { scenario, conversationId, requestId, clientThreadId: body.clientThreadId || null,
        runId, answerId: `${conversationId}/${runId}`, status: 'running', stopRequested: false,
        messages: new Map([[`${runId}-native-user`, { id: `${runId}-native-user`, role: 'user',
          text: body.message, content: body.message, status: 'completed', createdAt: Date.now() }]]),
        activities: new Map(), artifacts: [], pendingApprovals: [], error: null };
      if (scenario === 'CONTEXT') {
        if (Object.keys(body.contextCapabilities || {}).length !== 3
            || !['read', 'reader', 'publishBriefing'].every(key => body.contextCapabilities[key] === true)) throw new Error('Explicit context capabilities required');
        run.fixtureOwner = accountVariant;
        run.contextCaptures = context.bind(body.contextSnapshotIds, run, accountVariant);
        run.contextEvents = [];
        run.fixtureStage = 'context-bound';
      }
      runs.set(runId, run);
      const observedSend = { ...body, scenario, runId, acceptedAt: Date.now() };
      observed.sends.push(observedSend);
      envelope(run, 'run.started'); // Deliberately before the POST response.
      if (scenario === 'CONTEXT') envelope(run, 'context.bound', { captures: run.contextCaptures });
      setTimeout(() => {
        json(res, 202, { accepted: true, conversationId, requestId, runId, answerId: run.answerId });
        observedSend.respondedAt = Date.now();
        if (scenario === 'COMPLETE') completeScenario(run);
        else if (scenario === 'TEXT_ONLY') textOnlyScenario(run);
        else if (scenario === 'STOP') stopScenario(run);
        else if (scenario === 'APPROVAL') approvalScenario(run);
        else if (scenario !== 'CONTEXT') unavailableScenario(run);
      }, 80);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/chat/interrupt') {
      const body = await bodyJson(req);
      const run = runs.get(body.runId);
      if (!run || run.conversationId !== body.conversationId || run.status !== 'running') {
        return json(res, 404, { accepted: false, stopRequested: false });
      }
      const hold = run.stopAckHold;
      if (hold && ['armed', 'pending'].includes(hold.state) && Date.now() >= hold.deadlineAt) expireStopHold(run);
      if (hold && hold.state !== 'armed') return json(res, 409, { accepted: false, stopRequested: false, code: 'QA_STOP_HOLD_ALREADY_USED' });
      observed.interrupts.push({ conversationId: body.conversationId, runId: body.runId, requestedAt: Date.now() });
      if (hold) {
        hold.state = 'pending';
        hold.response = res;
        hold.onClose = () => settleStopHold(run, 'cancelled');
        res.once?.('close', hold.onClose);
        return;
      }
      acknowledgeStop(run, res);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/chat/approval') {
      const body = await bodyJson(req);
      const run = runs.get(body.runId);
      const approval = run?.pendingApprovals.find((item) => item.approvalId === body.approvalId);
      if (!run || run.conversationId !== body.conversationId || !approval ||
          approval.status !== 'pending' || connection !== 'ready') {
        return json(res, 409, { code: 'STALE_APPROVAL', error: 'Approval no longer belongs to this pending run' });
      }
      if (!approval.choices.includes(body.decision)) return json(res, 400, { code: 'INVALID_DECISION', error: 'Choice is not offered' });
      observed.approvals.push({ ...body, repliedAt: Date.now() });
      approval.status = 'replySent';
      run.fixtureStage = 'approval-reply-sent';
      run.approvalDecision = body.decision;
      json(res, 202, { accepted: true, approvalId: approval.approvalId,
        conversationId: run.conversationId, runId: run.runId, status: 'replySent' });
      return;
    }
    if (req.method === 'POST' && ['/terminal/spawn', '/terminal/read', '/terminal/kill', '/terminal/resize'].includes(url.pathname)) {
      if (terminalMode !== 'unknown') return json(res, 403, { error: 'Terminal fixture mode is not explicitly enabled' });
      const body = await bodyJson(req);
      if (url.pathname === '/terminal/spawn') {
        const sessionId = `qa-terminal-${randomUUID()}`;
        fixtureTerminals.set(sessionId, { stopRequested: false });
        return json(res, 200, { sessionId, shell: 'QA fixture; no process spawned', cols: body.cols, rows: body.rows });
      }
      const session = fixtureTerminals.get(body.sessionId);
      if (!session || (session.stopRequested && url.pathname === '/terminal/read')) return json(res, 404, {
        ok: false, sessionId: body.sessionId, status: 'UNKNOWN', exited: null, exitConfirmed: false,
        code: 'UNKNOWN_SESSION', error: 'Terminal session is unknown to this fixture', data: '',
      });
      if (url.pathname === '/terminal/kill') session.stopRequested = true;
      return json(res, 200, { ok: true, sessionId: body.sessionId, status: session.stopRequested ? 'STOP_REQUESTED' : 'RUNNING',
        stopRequested: session.stopRequested, exited: false, exitConfirmed: false, data: '' });
    }
    return json(res, 404, { error: 'Fixture route not found' });
  } catch (error) {
    return json(res, error.httpStatus || 400, { error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
};
const dispose = () => {
  for (const run of runs.values()) if (['armed', 'pending'].includes(run.stopAckHold?.state)) expireStopHold(run, 'disposed');
};
return { handler, dispose, info: { kind: 'egdesk-qa-fixture-ready', host: HOST, port: PORT,
  profile, artifactPath, streamId, scope: 'explicit opt-in, temp-only, no shipped runtime replacement' } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const params = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!process.argv[i]?.startsWith('--') || !process.argv[i + 1]) throw new Error('Expected --profile /path');
    params.set(process.argv[i], process.argv[i + 1]);
  }
  if (process.env.EGDESK_QA_FIXTURE_TRANSPORT !== '1' || params.size !== 1 || !params.has('--profile')) {
    throw new Error('Fixture CLI requires EGDESK_QA_FIXTURE_TRANSPORT=1 and only --profile /canonical/path');
  }
  const fixture = createQaFixtureTransport({ profile: params.get('--profile'), token: process.env.EGDESK_QA_FIXTURE_TOKEN });
  const server = http.createServer(fixture.handler);
  server.on('close', fixture.dispose);
  server.listen(PORT, HOST, () => process.stdout.write(`${JSON.stringify(fixture.info)}\n`));
}
