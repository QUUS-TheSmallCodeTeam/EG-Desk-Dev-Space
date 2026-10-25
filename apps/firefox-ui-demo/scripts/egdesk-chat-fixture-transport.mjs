#!/usr/bin/env node
// Developer-only HTTP/SSE fixture. Never imported by the shipped bridge.
// Main prepares an isolated QA overlay and explicitly starts this on its own
// port before launching QA Firefox. The personal bridge :39218 is never used.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomUUID } from 'node:crypto';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { assertOrdinarySend } from './egdesk-chat-qa-contract.sys.mjs';
import { createQaContextFixture } from './egdesk-context-qa-fixture.mjs';
import { observeQaFixtureFile } from './egdesk-context-qa-contract.mjs';
import { qaBridgeConfig, validateQaFixtureIsolation } from './egdesk-qa-fixture-isolation.mjs';
import { projectFileFixtureEnabled } from './egdesk-qa-fixture-isolation.mjs';
import { createProjectFileFixture } from './egdesk-project-file-fixture.mjs';
import { chatRunOutputsFixtureEnabled, createChatRunOutputsFixture } from './egdesk-chat-run-outputs-fixture.mjs';
import { portableTransferFixtureEnabled, createPortableTransferFixture } from './egdesk-portable-transfer-fixture.mjs';
import { taskGateFixtureEnabled, createTaskGateFixture, assertQaEmptyProjectSend } from './egdesk-task-gate-fixture.mjs';
import { chatOriginFileFixtureEnabled, createChatOriginFileFixture } from './egdesk-chat-origin-file-fixture.mjs';
import { routePermissionRequest } from '../helper/claude-engine-permissions.mjs'; // Pure shape translation only.
import { guardBridgeRequest } from '../helper/codex-bridge-http.mjs';
import { readEGDeskFileBody } from '../helper/egdesk-file-http.mjs';

const SCENARIO = /^EGDESK_QA_(COMPLETE|TEXT_ONLY|STOP|APPROVAL|USER_INPUT|SUBAGENT|LOST|START_FAIL|REJECT|AMBIGUOUS|CONTEXT|CLAUDE_TEXT|CLAUDE_SESSION_APPROVAL|CLAUDE_APPROVAL_NO_SESSION|CLAUDE_MULTI_SELECT|CLAUDE_RATE_LIMIT|CLAUDE_CONTEXT|CLAUDE_CONTEXT_BLOCKED)\b/;
export const CLAUDE_CONTEXT_TOOLS = Object.freeze(['egdesk_list_context', 'egdesk_read_source']);
export const CLAUDE_FIXTURE_TEXT = 'Claude QA fixture: Codex가 연결되지 않아도 이 대화의 답변은 Claude로 표시됩니다.';
export const CLAUDE_FIXTURE_QUESTIONS = Object.freeze([
  { questionId: 'q0', header: '검토 범위', question: 'QA fixture: 검토할 항목을 모두 선택하세요.', multiSelect: true,
    options: [{ label: '문서', description: '문서 확인' }, { label: '코드', description: '코드 확인' },
      { label: '검증', description: '검증 결과 확인' }], allowsOther: true, isSecret: false },
  { questionId: 'q1', header: '정리 방식', question: 'QA fixture: 한 가지 정리 방식을 선택하세요.',
    options: [{ label: '요약', description: '짧은 요약' }, { label: '상세', description: '자세한 설명' }],
    allowsOther: true, isSecret: false },
]);

// Public /v1/state rows, not adapters: no credential, SDK, provider or process.
export function claudeFixtureEngines(accountVariant = 'a') {
  return [{ id: 'codex', label: 'Codex', status: 'offline', isDefault: true, capabilities: [], profiles: [], models: null,
    runtime: { residentProcesses: 0, residentLimit: 0, idleTimeoutMs: null } },
  { id: 'claude', label: 'Claude', status: 'ready', installed: true, version: '2.1.0', versionStatus: 'supported',
    versionSupported: null, isDefault: false, capabilities: ['stream', 'resume', 'nativeHistory', 'interrupt',
      'approvals.command', 'userInput', 'userInput.multiSelect', 'usage.rateLimits'], models: null,
    profiles: [{ id: 'claude-default', label: 'QA Claude', credentialStore: 'claude-cli', active: true,
      auth: { status: 'signedIn', method: 'claude', account: accountVariant === 'a' ? 'qa-claude@egdesk.invalid' : 'qa-claude-b@egdesk.invalid', planType: 'max' }, usage: null }],
    runtime: { residentProcesses: 0, residentLimit: 2, idleTimeoutMs: 300000 } }];
}
// Same public bounds the helper enforces before a question reaches SSE.
const INPUT_LIMITS = { questions: 8, options: 12, header: 200, question: 2000, label: 200, description: 1000, answer: 4000 };
const SUBAGENT_STATES = new Set(['starting', 'running', 'completed', 'errored', 'interrupted', 'closed', 'notFound', 'unknown']);
const SUBAGENT_BLOCKS = new Set(['approvalRequested', 'errored', 'notFound']);
const SUBAGENT_KEYS = ['threadId', 'label', 'taskPreview', 'model', 'state', 'message', 'lastTool', 'blocked', 'updatedAt', 'parentEnded'];

const bounded = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const boundedOrNull = (value, max) => value === null || bounded(value, max);

function assertPublicUserInput(input) {
  const ok = Array.isArray(input.questions) && input.questions.length >= 1 && input.questions.length <= INPUT_LIMITS.questions
    && new Set(input.questions.map(question => question.questionId)).size === input.questions.length
    && input.questions.every(question => bounded(question.questionId, 200) && bounded(question.header, INPUT_LIMITS.header)
      && bounded(question.question, INPUT_LIMITS.question) && typeof question.isSecret === 'boolean'
      && (question.options === null ? question.allowsOther === false
        : Array.isArray(question.options) && question.options.length >= 1 && question.options.length <= INPUT_LIMITS.options
          && question.allowsOther === true && question.options.every(option => bounded(option.label, INPUT_LIMITS.label)
            && typeof option.description === 'string' && option.description.length <= INPUT_LIMITS.description)));
  if (!ok) throw new Error('Fixture user input exceeds the public contract');
  return input;
}

function assertSubAgentRow(row) {
  if (JSON.stringify(Object.keys(row)) !== JSON.stringify(SUBAGENT_KEYS) || !bounded(row.threadId, 200)
      || !boundedOrNull(row.label, 120) || !boundedOrNull(row.taskPreview, 160) || !boundedOrNull(row.message, 500)
      || !SUBAGENT_STATES.has(row.state) || !(row.blocked === null || SUBAGENT_BLOCKS.has(row.blocked?.reason))
      || typeof row.parentEnded !== 'boolean' || !Number.isSafeInteger(row.updatedAt)) {
    throw new Error('Fixture sub-agent row exceeds the public contract');
  }
  return row;
}

// Importing this factory starts no service. Unit tests invoke the handler with
// in-memory requests; only the explicit CLI below is allowed to listen.
export function createQaFixtureTransport({ profile: profilePath, token, env = process.env }) {
const config = qaBridgeConfig(env);
const isolation = validateQaFixtureIsolation(profilePath, { env, requireFresh: true });
const { port: PORT, host: HOST, origin } = config;
if (env.EGDESK_QA_CLAUDE_FIXTURE != null && env.EGDESK_QA_CLAUDE_FIXTURE !== '1') throw new Error('Invalid Claude fixture gate');
const claudeFixture = env.EGDESK_QA_CLAUDE_FIXTURE === '1';
if (claudeFixture && env.EGDESK_QA_REAL_TURN === '1') throw new Error('Claude fixtures forbid real-provider mode');
const runOutputsEnabled = chatRunOutputsFixtureEnabled(env);
const taskGateEnabled = taskGateFixtureEnabled(env);
const originFileEnabled = chatOriginFileFixtureEnabled(env);
if (runOutputsEnabled && claudeFixture) throw new Error('Run outputs require a separate fixture mode from Claude');
if (env.EGDESK_QA_CLAUDE_READER_FIXTURE != null && !['0', '1'].includes(env.EGDESK_QA_CLAUDE_READER_FIXTURE)) throw new Error('Invalid synthetic Claude Reader gate');
const claudeReaderFixture = env.EGDESK_QA_CLAUDE_READER_FIXTURE === '1';
if (claudeReaderFixture && (!claudeFixture || env.EGDESK_QA_REAL_TURN !== '0')) throw new Error('Synthetic Reader requires isolated Claude fixture and explicit real-turn zero');
if (typeof token !== 'string' || token.length < 16) throw new Error('Fixture token must contain at least 16 characters');
if ((taskGateEnabled || originFileEnabled) && env.EGDESK_QA_FIXTURE_TOKEN != null && token !== env.EGDESK_QA_FIXTURE_TOKEN) {
  throw new Error('Async fixture canonical token mismatch');
}
const fixture = assertQaFixtureManifest(profilePath);
const profile = fixture.profile;
if (originFileEnabled && fs.lstatSync(path.join(profile, 'prefs.js'), { throwIfNoEntry: false })) {
  throw new Error('Origin File requires a fresh prefs-less owned QA profile');
}
const projectFileFixture = projectFileFixtureEnabled(env)
  ? createProjectFileFixture({ profile, token, env }) : null;
const portableTransferFixture = portableTransferFixtureEnabled(env)
  ? createPortableTransferFixture({ profile, token, env }) : null;
const modelFreeFixture = !!(projectFileFixture || portableTransferFixture);
const artifactRoot = fixture.root;
const artifactPath = fixture.artifactPath;
const context = createQaContextFixture(profile);
let failNextCapture = false;
let holdNextCapture = false;
const heldCaptures = [];

const streamId = randomUUID();
// Per-fixture lifetime expectation, not an owner grant or reusable credential.
const contextScopeKey = randomUUID();
let seq = 0;
let turnCounter = 0;
let connection = claudeFixture || modelFreeFixture ? 'offline' : 'ready';
let authLookupFails = false;
let authLoggedIn = !claudeFixture && !modelFreeFixture;
let accountVariant = 'a';
let claudeAccountVariant = 'a';
let claudeEpoch = 0;
let claudeContextAvailable = true;
let claudeReaderAvailable = claudeReaderFixture;
let claudeCapacityKnown = true;
const engineRows = () => claudeFixtureEngines(claudeAccountVariant);
let holdResume = false;
let partialHistory = false;
let terminalMode = null;
let userInputRpc = 0;
const heldResumes = [];
const fixtureTerminals = new Map();
const clients = new Set();
const runs = new Map();
const runOutputsFixture = runOutputsEnabled ? createChatRunOutputsFixture({ runs, envelope, env }) : null;
const failedStarts = new Map();
const observed = { sends: [], interrupts: [], resumes: [], approvals: [], userInputs: [], authWrites: [], events: [], reconnects: 0, replays: 0, heldResumes: 0, releasedResumes: 0, contextCaptureFailures: 0 };
if (claudeFixture) Object.assign(observed, { blockedContexts: [], captures: [], contextRefusals: [] });
if (runOutputsFixture) observed.approvalPostAttempts = 0;
let taskGateFixture = null, taskGateClosing = false, taskGateClosePromise = null;
const taskGateReady = taskGateEnabled ? createTaskGateFixture({ profile, token, env,
  broadcast: frame => {
    // The real runtime's identity/sequence remains unchanged inside the
    // existing event:codex SSE envelope; no second stream or listener.
    observed.taskGateBroadcasts = (observed.taskGateBroadcasts || 0) + 1;
    broadcastFixtureEvent(frame);
  } }).then(value => { taskGateFixture = value; return value; }) : null;
// A caller may attach the HTTP handler before awaiting readiness. Keep a
// rejected initialization observable by ready/handler/dispose, not unhandled.
if (taskGateReady) void taskGateReady.catch(() => {});
let originFileFixture = null, originFileClosing = false, originFileClosePromise = null;
const originFileReady = originFileEnabled ? createChatOriginFileFixture({ profile, token, env,
  broadcast: frame => {
    observed.originFileBroadcasts = (observed.originFileBroadcasts || 0) + 1;
    broadcastFixtureEvent(frame);
  } }).then(value => { originFileFixture = value; return value; }) : null;
if (originFileReady) void originFileReady.catch(() => {});
const runConnection = run => run?.engineId === 'claude' ? 'ready' : connection;
const activeRun = run => ['running', 'inProgress'].includes(run?.status);
const contextError = (code, message, httpStatus = 409) => { throw Object.assign(new Error(message), { code, httpStatus }); };
const claudeOwner = () => `claude:claude-default:qa-account-${claudeAccountVariant}`;
function claudeContextRouting(body) {
  if (!body || ['ownerKey', 'epoch', 'ownerScope', 'contextAuthority'].some(key => Object.hasOwn(body, key))) {
    contextError('INVALID_CONTEXT_ROUTING', 'UI cannot supply fixture context authority', 400);
  }
  if (body.engineId !== 'claude' || body.engineProfileId != null && body.engineProfileId !== 'claude-default') {
    contextError('ENGINE_MISMATCH', 'Expected the selected Claude engine/profile', 403);
  }
  if (typeof body.clientThreadId !== 'string' || !body.clientThreadId || body.clientThreadId.length > 200) {
    contextError('CONTEXT_THREAD_MISMATCH', 'Explicit UI client thread required', 400);
  }
  if (body.conversationId && ![...runs.values()].some(run => run.conversationId === body.conversationId
      && run.clientThreadId === body.clientThreadId && run.engineId === 'claude'
      && (!run.fixtureOwner || run.fixtureOwner === claudeOwner()))) {
    contextError('CONTEXT_THREAD_MISMATCH', 'Context route belongs to another conversation/account', 403);
  }
  return { engineId: 'claude', engineProfileId: 'claude-default', clientThreadId: body.clientThreadId,
    ...(body.conversationId ? { conversationId: body.conversationId } : {}), owner: claudeOwner(), epoch: claudeEpoch };
}
function assertClaudeContextCurrent(authority) {
  if (authority.owner !== claudeOwner() || authority.epoch !== claudeEpoch) contextError('ACCOUNT_CHANGED', 'Claude account changed during fixture operation', 403);
}
function expectedClaudeContextScope(authority) {
  return createHmac('sha256', contextScopeKey).update(JSON.stringify([
    authority.engineId, authority.engineProfileId, authority.owner, authority.epoch, authority.clientThreadId,
  ])).digest('hex'); // Native conversation intentionally excluded.
}
function assertClaudeContextExpectation(body, authority) {
  if (typeof body.expectedContextScope !== 'string' || body.expectedContextScope !== expectedClaudeContextScope(authority)) {
    contextError('CONTEXT_SCOPE_CHANGED', 'Claude context scope changed; keep the draft and confirm the current account', 409);
  }
}

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
    ...(run.engineId ? { engineId: run.engineId } : {}),
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
  if (modelFreeFixture) return { isLoggedIn: false, loginInProgress: false,
    statusText: portableTransferFixture ? 'Portable transfer QA: no provider' : 'Project QA: no provider',
    requiresOpenaiAuth: true, accountId: null, authMode: null, accountEmail: null };
  return { isLoggedIn: authLoggedIn, loginInProgress: false, statusText: 'QA fixture only',
    requiresOpenaiAuth: !authLoggedIn, accountId: 'chatgpt', authMode: 'chatgpt',
    accountEmail: `qa-account-${accountVariant}@egdesk.invalid` };
}

function broadcastFixtureEvent(event) {
  for (const client of clients) client.write(`event: codex\ndata: ${JSON.stringify(event)}\n\n`);
}

function runState(run) {
  return { runId: run.runId, answerId: run.answerId, status: run.status,
    ...(run.engineId ? { engineId: run.engineId, engine: run.engine } : {}),
    ...(run.rateLimit ? { rateLimit: structuredClone(run.rateLimit) } : {}),
    stopRequested: run.stopRequested, messages: [...run.messages.values()],
    activities: [...run.activities.values()], artifacts: [...run.artifacts],
    pendingApprovals: [...run.pendingApprovals], error: run.error,
    pendingUserInputs: structuredClone(run.pendingUserInputs), subAgents: structuredClone(run.subAgents),
    ...(run.truncated ? { truncated: true } : {}),
    ...(run.contextCaptures ? { contextCaptures: run.contextCaptures, contextEvents: run.contextEvents || [], briefing: run.briefing || null } : {}) };
}

function contextPhase(run, phase) {
  if (!['CONTEXT', 'CLAUDE_CONTEXT'].includes(run.scenario)) throw new Error('Not a scoped context fixture run');
  const directOnly = run.engineId === 'claude';
  if (directOnly) assertClaudeContextCurrent(run.fixtureContextAuthority);
  if (directOnly && !activeRun(run)) contextError('CONTEXT_RUN_INACTIVE', 'Ended fixture runs cannot read, deliver or complete');
  const record = (name, details) => {
    const event = envelope(run, name, details);
    run.contextEvents.push({ id: `${event.streamId}:${event.seq}`, event: name, ts: event.ts, details: structuredClone(details) });
  };
  if (run.fixtureReaderRequired) {
    const sourceId = run.contextCaptures[0].sourceId;
    if (phase === 'read' && ['context-bound', 'context-read-partial'].includes(run.fixtureStage)) {
      if (!claudeReaderAvailable) contextError('CLAUDE_CONTEXT_READER_UNSUPPORTED', 'Synthetic Reader capability is unavailable');
      if (!claudeCapacityKnown) contextError('ENGINE_CAPACITY_UNKNOWN', 'Synthetic capacity is unknown; no Reader started');
      record('context.read.started', { sourceId, toolName: 'egdesk_read_source', fixtureOnly: true });
      record('reader.started', context.startReader(sourceId, run, run.fixtureOwner));
      run.fixtureStage = 'reader-running';
      return;
    }
    if (phase === 'reader-processed' && run.fixtureStage === 'reader-running') {
      record('reader.completed', context.processReader(sourceId, run, run.fixtureOwner));
      run.fixtureStage = 'reader-prepared';
      return;
    }
    if (phase === 'reader-deliver' && run.fixtureStage === 'reader-prepared') {
      const packet = context.deliverReader(sourceId, run, run.fixtureOwner);
      (run.contextPackets ||= []).push(packet);
      record('context.read.completed', { sourceId, toolName: 'egdesk_read_source', packetId: packet.packetId,
        hash: packet.hash, coverage: packet.coverage, deliveryStatus: packet.deliveryStatus, fixtureOnly: true });
      run.fixtureStage = packet.coverage.complete ? 'context-read' : 'context-read-partial';
      return;
    }
    if (phase === 'reader-fail' && ['reader-running', 'reader-prepared'].includes(run.fixtureStage)) {
      context.abandonReader(sourceId, run, run.fixtureOwner);
      run.error = { code: 'READER_FAILED', message: 'Synthetic QA Reader failure; no fallback or model invocation.' };
      record('reader.failed', { sourceId, code: run.error.code, fixtureOnly: true });
      record('context.read.failed', { sourceId, code: run.error.code, fixtureOnly: true });
      run.status = 'failed';
      run.fixtureStage = 'terminal';
      envelope(run, 'run.completed', { status: 'failed', error: run.error });
      return;
    }
    if (phase !== 'complete') contextError('CONTEXT_PHASE_MISMATCH', 'Reader requires explicit start, bounded processing and delivery phases');
  }
  if (phase === 'read' && run.fixtureStage === 'context-bound') {
    run.contextPackets = [];
    for (const capture of run.contextCaptures) {
      const details = { sourceId: capture.sourceId, toolName: 'egdesk_read_source', fixtureOnly: true };
      envelope(run, 'context.read.started', details);
      const packet = context.deliver(capture.sourceId, run, run.fixtureOwner, { directOnly });
      run.contextPackets.push(packet);
      const complete = { ...details, packetId: packet.packetId, hash: packet.hash };
      envelope(run, 'context.read.completed', complete);
      run.contextEvents.push({ event: 'context.read.completed', details: complete });
    }
    run.fixtureStage = 'context-read';
    return;
  }
  if (directOnly && phase === 'complete' && run.fixtureStage === 'context-read') {
    const messageId = `${run.runId}-message`, text = 'Claude QA fixture: selected immutable Context recorded; no model was invoked.';
    run.messages.set(messageId, { id: messageId, role: 'assistant', status: 'completed', text });
    envelope(run, 'message.started', { messageId, phase: 'answer' }, messageId);
    envelope(run, 'message.completed', { messageId, text, phase: 'answer' }, messageId);
    run.status = 'completed';
    envelope(run, 'run.completed', { status: 'completed' });
    run.fixtureStage = 'terminal';
    return;
  }
  if (directOnly) contextError('CONTEXT_TOOL_UNSUPPORTED', 'Claude fixture permits only list/read, not Briefing or output tools');
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
  const owned = [...runs.values()].find(run => run.conversationId === conversationId);
  return { streamId, seq, connection: runConnection(owned), conversationId,
    ...(owned?.engineId ? { engineId: owned.engineId } : {}),
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

function userInputScenario(run) {
  const input = assertPublicUserInput({ userInputId: `input:${streamId}:0:number:${++userInputRpc}`, kind: 'userInput',
    status: 'pending', itemId: `${run.runId}-user-input`, isBlocking: true, questions: [
      { questionId: 'qa_scope', header: '정리 범위', question: 'QA fixture: 결과를 어느 범위로 정리할까요?',
        options: [{ label: '요약만', description: '핵심 결론만 짧게 정리합니다.' },
          { label: '근거 포함', description: '판단 근거와 출처를 함께 정리합니다.' }], allowsOther: true, isSecret: false },
      { questionId: 'qa_private_note', header: '비공개 메모', question: 'QA fixture: 비공개로 전달할 메모를 입력하세요.',
        options: null, allowsOther: false, isSecret: true },
    ] });
  run.pendingUserInputs.push(input);
  run.fixtureStage = 'user-input-pending';
  // Clone: later replySent must not rewrite the recorded/replayed required event.
  envelope(run, 'userInput.required', structuredClone(input), input.itemId);
}

// Only the shape and a token-keyed digest of free text leave this route.
function userInputAnswers(input, body) {
  if (body.action === 'skip') return body.answers === undefined || (Array.isArray(body.answers) && !body.answers.length) ? [] : null;
  if (body.action !== 'submit' || !Array.isArray(body.answers) || body.answers.length !== input.questions.length) return null;
  const result = [];
  for (const answer of body.answers) {
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)
        || Object.keys(answer).some(key => !['questionId', 'optionIndex', 'optionIndices', 'text'].includes(key))) return null;
    const index = input.questions.findIndex(item => item.questionId === answer.questionId);
    const question = input.questions[index];
    if (!question || result.some(item => item.questionId === question.questionId)) return null;
    const hasIndex = answer.optionIndex !== undefined;
    const hasIndices = answer.optionIndices !== undefined;
    if (Number(hasIndex) + Number(hasIndices) + Number(answer.text !== undefined) !== 1) return null;
    if (hasIndices) {
      const indices = answer.optionIndices;
      if (question.multiSelect !== true || !question.options || !Array.isArray(indices) || !indices.length
          || indices.length > question.options.length || new Set(indices).size !== indices.length
          || indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= question.options.length)) return null;
      result.push({ index, questionId: question.questionId, isSecret: question.isSecret,
        optionIndices: [...indices], labels: indices.map(index => question.options[index].label) });
      continue;
    }
    if (hasIndex) {
      if (!question.options || !Number.isSafeInteger(answer.optionIndex) || answer.optionIndex < 0
          || answer.optionIndex >= question.options.length) return null;
      result.push({ index, questionId: question.questionId, isSecret: question.isSecret,
        optionIndex: answer.optionIndex, label: question.options[answer.optionIndex].label });
      continue;
    }
    if (typeof answer.text !== 'string' || answer.text.includes('\0') || (question.options && !question.allowsOther)) return null;
    const text = answer.text.trim();
    if (!text || text.length > INPUT_LIMITS.answer) return null;
    result.push({ index, questionId: question.questionId, isSecret: question.isSecret,
      textLength: text.length, textDigest: createHmac('sha256', token).update(text).digest('hex') });
  }
  return result.sort((a, b) => a.index - b.index).map(({ index, ...item }) => item);
}

function resolveUserInput(run) {
  const { userInputId } = run.pendingUserInputs[0];
  run.pendingUserInputs = [];
  envelope(run, 'userInput.resolved', { userInputId });
  // The same native run continues after the reply; completion stays a separate release.
  const messageId = `${run.runId}-message`;
  const text = run.userInputAction === 'skip' ? 'QA fixture: 질문을 건너뛰어 기본 범위로 이어갑니다.'
    : 'QA fixture: 답변을 받아 같은 실행을 이어갑니다.';
  run.messages.set(messageId, { id: messageId, role: 'assistant', status: 'streaming', text });
  envelope(run, 'message.started', { messageId, phase: 'answer' }, messageId);
  envelope(run, 'message.delta', { messageId, delta: text, phase: 'answer' }, messageId);
  run.finishFixture = () => {
    run.messages.get(messageId).status = 'completed';
    envelope(run, 'message.completed', { messageId, text, phase: 'answer' }, messageId);
  };
  run.fixtureStage = 'user-input-resolved';
}

function updateSubAgent(run, threadId, fields) {
  const index = run.subAgents.findIndex(item => item.threadId === threadId);
  if (index < 0 && run.subAgents.length >= 32) { run.truncated = true; return; }
  const base = index < 0 ? { threadId, label: null, taskPreview: null, model: null, state: 'unknown', message: null,
    lastTool: null, blocked: null, updatedAt: 0, parentEnded: false } : run.subAgents[index];
  const row = assertSubAgentRow({ ...base, ...fields, threadId, updatedAt: Date.now() });
  if (index < 0) run.subAgents.push(row); else run.subAgents[index] = row;
  envelope(run, 'subagent.updated', { subAgent: structuredClone(row) });
}

function subAgentScenario(run) {
  const collab = { id: `${run.runId}-collab`, kind: 'collabAgentToolCall', status: 'inProgress',
    title: 'QA fixture: 하위 Agent 생성', detail: { tool: 'spawnAgent', status: 'inProgress', receiverCount: 3 }, sourceRefs: [] };
  const gather = { id: `${run.runId}-activity`, kind: 'commandExecution', status: 'inProgress',
    title: 'QA fixture: 하위 Agent 결과 모으기', sourceRefs: [] };
  for (const activity of [collab, gather]) {
    run.activities.set(activity.id, activity);
    envelope(run, 'activity.started', structuredClone(activity), activity.id);
  }
  const [done, errored, waiting] = [randomUUID(), randomUUID(), randomUUID()];
  const model = 'qa-fixture-model';
  updateSubAgent(run, done, { label: 'researcher', taskPreview: 'QA fixture: 공개 참고 자료를 읽고 핵심만 요약합니다.',
    model, state: 'running', lastTool: 'spawnAgent' });
  updateSubAgent(run, errored, { taskPreview: 'QA fixture: 존재하지 않는 경로를 확인합니다.', model, state: 'starting', lastTool: 'spawnAgent' });
  updateSubAgent(run, waiting, { label: 'reviewer', taskPreview: 'QA fixture: 변경 전 승인이 필요한 작업을 검토합니다.',
    model, state: 'running', lastTool: 'spawnAgent' });
  updateSubAgent(run, errored, { state: 'errored', message: 'QA fixture: 하위 작업이 오류로 끝났습니다.',
    lastTool: 'wait', blocked: { reason: 'errored' } });
  // A child approval request is refused (never granted); only the parent row records it.
  updateSubAgent(run, waiting, { blocked: { reason: 'approvalRequested' } });
  run.settleSubAgents = () => {
    updateSubAgent(run, done, { state: 'completed', message: 'QA fixture: 요약을 마쳤습니다.', lastTool: 'wait' });
    Object.assign(collab, { status: 'completed', detail: { ...collab.detail, status: 'completed' } });
    envelope(run, 'activity.completed', structuredClone(collab), collab.id);
    run.fixtureStage = 'subagents-settled';
  };
  run.finishFixture = () => {
    gather.status = 'completed';
    envelope(run, 'activity.completed', structuredClone(gather), gather.id);
    for (const row of [...run.subAgents]) updateSubAgent(run, row.threadId, { parentEnded: true });
  };
  run.fixtureStage = 'subagents-visible';
}

function unavailableScenario(run) {
  setTimeout(() => {
    connection = 'offline';
    run.status = 'failed';
    run.error = { code: 'RUNTIME_LOST', message: 'QA fixture runtime loss' };
    envelope(run, 'run.unavailable', { error: run.error });
  }, 200);
}

function claudeScenario(run) {
  if (run.scenario === 'CLAUDE_TEXT') {
    const messageId = `${run.runId}-message`;
    run.messages.set(messageId, { id: messageId, role: 'assistant', status: 'completed', text: CLAUDE_FIXTURE_TEXT });
    envelope(run, 'message.started', { messageId, phase: 'answer' }, messageId);
    envelope(run, 'message.completed', { messageId, text: CLAUDE_FIXTURE_TEXT, phase: 'answer' }, messageId);
    run.status = 'completed';
    envelope(run, 'run.completed', { status: run.status });
  } else if (['CLAUDE_SESSION_APPROVAL', 'CLAUDE_APPROVAL_NO_SESSION'].includes(run.scenario)) {
    const offerSession = run.scenario === 'CLAUDE_SESSION_APPROVAL';
    const command = "printf 'QA Claude fixture only'";
    const suggestion = { type: 'addRules', behavior: 'allow', destination: 'session',
      rules: [{ toolName: 'Bash', ruleContent: command }] };
    const routed = routePermissionRequest({ tool_name: 'Bash', tool_use_id: `${run.runId}-command`,
      input: { command }, ...(offerSession ? { permission_suggestions: [suggestion] } : {}) }, {
      threadId: run.conversationId, turnId: run.runId, rpcId: `${run.runId}-permission`,
      cwd: artifactRoot, offerSessionGrant: offerSession });
    if (routed.route !== 'approval' || (offerSession && !routed.pending.suggestions?.length)) {
      throw new Error('Claude fixture must offer a validated bounded session rule');
    }
    run.fixtureApprovalOffer = { synthetic: true, adapterExecutionVerified: false,
      choices: routed.serverRequest.params.availableDecisions,
      sessionRule: offerSession ? suggestion : null };
    const approval = { approvalId: `${run.runId}-approval`, kind: 'commandExecution', status: 'pending',
      choices: [...routed.serverRequest.params.availableDecisions],
      itemId: `${run.runId}-command`, reason: 'QA Claude approval only; no command is executed',
      command, cwd: artifactRoot };
    run.pendingApprovals.push(approval);
    run.fixtureStage = 'claude-approval-pending';
    envelope(run, 'approval.required', { approval: structuredClone(approval) }, approval.itemId);
  } else if (run.scenario === 'CLAUDE_MULTI_SELECT') {
    const input = assertPublicUserInput({ userInputId: `input:${streamId}:0:string:claude-${++userInputRpc}`,
      kind: 'userInput', status: 'pending', itemId: `${run.runId}-question`, isBlocking: true,
      questions: structuredClone(CLAUDE_FIXTURE_QUESTIONS) });
    run.pendingUserInputs.push(input);
    run.fixtureStage = 'user-input-pending';
    envelope(run, 'userInput.required', structuredClone(input), input.itemId);
  } else if (run.scenario === 'CLAUDE_RATE_LIMIT') claudeRateLimit(run, false);
}

function claudeRateLimit(run, rejected) {
  run.rateLimit = { engineId: 'claude', status: rejected ? 'rejected' : 'allowed_warning', window: 'fiveHour',
    windowMinutes: 300, resetsAt: Date.now() + (rejected ? 1500 : 60000), utilization: rejected ? 1 : 0.9,
    usedPercent: rejected ? 100 : 90, overageStatus: rejected ? 'rejected' : null,
    creditsRequired: rejected, autoResume: false };
  run.error = rejected ? { code: 'CLAUDE_CREDITS_REQUIRED', origin: 'claude', kind: 'quota',
    message: 'Claude usage requires additional credits', retryAt: run.rateLimit.resetsAt } : null;
  envelope(run, 'run.rateLimit', { rateLimit: structuredClone(run.rateLimit), error: run.error });
  run.fixtureStage = rejected ? 'claude-rate-rejected' : 'claude-rate-warning';
  if (rejected) {
    run.status = 'failed';
    envelope(run, 'run.completed', { status: run.status, error: run.error });
  }
  // Display-only state; deliberately no timer, retry, resume, credit action or send.
}

function refuseClaudeContext(res, route) {
  observed.blockedContexts.push({ route, at: Date.now() });
  return json(res, 409, { accepted: false, code: 'CLAUDE_CONTEXT_UNSUPPORTED',
    error: 'Claude Context is not engine-portable; remove selected Context before sending' });
}

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, origin);
    if (url.origin !== origin || url.username || url.password
        || (req.headers.host && req.headers.host !== `${HOST}:${PORT}`)
        || (req.socket?.remoteAddress && !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress))) {
      return json(res, 400, { error: 'Fixture accepts only its loopback origin' });
    }
    if (originFileReady) {
      if (originFileClosing) return json(res, 503, { code: 'QA_FIXTURE_CLOSED', error: 'Origin File fixture is closed' });
      try { await originFileReady; }
      catch { return json(res, 503, { code: 'QA_ORIGIN_FILE_UNAVAILABLE', error: 'Real Origin File fixture initialization failed' }); }
      // This sidecar owns EVERY Chat/File path, including refusals. It must
      // precede both synthetic Chat and the ordinary empty room-default read.
      if (await originFileFixture.handle(req, res, url)) return;
    }
    if (taskGateReady) {
      if (taskGateClosing) return json(res, 503, { code: 'QA_FIXTURE_CLOSED', error: 'Task fixture is closed' });
      try { await taskGateReady; }
      catch { return json(res, 503, { code: 'QA_TASK_GATE_UNAVAILABLE', error: 'Real Task fixture initialization failed' }); }
      // Task/Chat are actual handlers. False alone reaches ordinary fixture
      // discovery/read-only fallbacks; no successful Task response fabricated.
      if (await taskGateFixture.handle(req, res, url)) return;
    }
    if (runOutputsFixture && req.method === 'POST' && url.pathname === '/chat/approval') observed.approvalPostAttempts++;
    const outputResponse = runOutputsFixture?.route(req.method, url);
    if (outputResponse) return json(res, outputResponse.status, outputResponse.body);
    if (projectFileFixture && await projectFileFixture.handle(req, res, url)) return;
    if (portableTransferFixture) {
      // Preflight only for the sidecar's exact allowlisted routes. All actual
      // reads/imports and all rejected mutations go through its real handlers.
      const preflight = /^\/profiles(?:\/(?:import|tool-presets|[a-z0-9][a-z0-9-]{0,79}(?:\/revisions(?:\/[1-9]\d{0,8})?|\/export)?))?$/.test(url.pathname)
        || /^\/v1\/boards(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}(?:\/export)?)?$/.test(url.pathname) || url.pathname === '/v1/desk/current';
      if (req.method === 'OPTIONS' && preflight) {
        if (!guardBridgeRequest(req, PORT)) return json(res, 403, { code: 'QA_LOOPBACK_REQUIRED' });
        return json(res, 204, {});
      }
      if (await portableTransferFixture.handle(req, res, url)) return;
    }
    // Ordinary Chat fixtures have no project store. D-X3 still reads this
    // endpoint on room entry: return the canonical empty view, never a saved
    // default, active-Board inference, or a successful write. Project mode's
    // actual adapter above always owns its read/save routes first.
    if (!projectFileFixture && url.pathname === '/v1/files/projects/room-default') {
      if (!guardBridgeRequest(req, PORT)) return json(res, 403, { ok: false, code: 'LOOPBACK_REQUIRED', error: 'Trusted loopback origin is required' });
      if (url.search) return json(res, 400, { ok: false, code: 'INVALID_PROJECT_REQUEST', error: 'Room-default query accepts no URL parameters' });
      if (req.method === 'OPTIONS') return json(res, 204, {});
      if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED', error: 'Room-default query requires POST' });
      const body = await readEGDeskFileBody(req, 'readRoomProjectDefault');
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 ||
          typeof body.roomId !== 'string' || !body.roomId.trim() || body.roomId.length > 512 || body.roomId.includes('\0')) {
        return json(res, 400, { ok: false, code: 'INVALID_PROJECT_REQUEST', error: 'Exactly one bounded nonempty roomId is required' });
      }
      const reads = observed.roomDefaultReads ||= [];
      if (reads.length >= 512) return json(res, 429, { ok: false, code: 'QA_TRACE_LIMIT', error: 'Bounded room-default read trace is full' });
      reads.push({ roomId: body.roomId });
      return json(res, 200, { ok: true, result: { roomId: body.roomId, inheritance: null, override: null,
        project: null, source: null, status: 'none' } });
    }
    if (projectFileFixture && req.method === 'POST' && url.pathname === '/chat/send') {
      return json(res, 403, { accepted: false, code: 'PROJECT_QA_MODEL_DISABLED', error: 'Project QA never starts model turns' });
    }
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
        '/chat/send', '/chat/interrupt', '/chat/approval', '/chat/user-input', '/__qa/state', '/__qa/release',
        '/__qa/auth-refresh', '/__qa/reconnect', '/__qa/replay', '/auth/signout', '/__qa/hold-resume',
        '/__qa/release-resume', '/__qa/history', '/__qa/delta', '/__qa/auth-diagnostics', '/__qa/runtime-ready',
        '/__qa/account-change', '/__qa/terminal-mode', '/terminal/spawn', '/terminal/read', '/terminal/kill', '/terminal/resize',
        '/context/captures', ...(claudeFixture ? ['/context/capabilities'] : []), '/__qa/context-config', '/__qa/context-release', '/__qa/hold-stop', '/__qa/release-stop'];
      return json(res, paths.includes(url.pathname) || /^\/context\/captures\/[\da-f-]{36}$/i.test(url.pathname) ? 204 : 404, {});
    }
    if (req.method === 'GET' && url.pathname === '/__qa/state') {
      if (req.headers['x-egdesk-qa-token'] !== token) return json(res, 403, { error: 'Fixture token required' });
      return json(res, 200, { fixture: true, profile, host: HOST, port: PORT, origin, artifactRoot, artifactPath,
        ...(projectFileFixture ? { projectFileFixture: true, providerTurns: 0,
          nativePickerInvocations: 0, nativeProcessSpawns: 0 } : {}),
        ...(claudeFixture ? { claudeFixture: true, claudeReaderFixture, providerTurns: 0 } : {}),
        ...(runOutputsFixture ? { runOutputsFixture: true, providerTurns: 0, runOutputs: runOutputsFixture.stats() } : {}),
        ...(portableTransferFixture ? { portableTransferFixture: true, providerTurns: 0,
          nativePickerInvocations: 0, nativeProcessSpawns: 0, portableTransfer: portableTransferFixture.snapshot() } : {}),
        ...(taskGateFixture ? { taskGateFixture: true, providerTurns: 0, nativeProcessSpawns: 0, taskGate: taskGateFixture.snapshot() } : {}),
        ...(originFileFixture ? { chatOriginFileFixture: true, providerTurns: 0, nativeProcessSpawns: 0, chatOriginFile: originFileFixture.snapshot() } : {}),
        streamId, seq, clients: clients.size, observed, context: context.stats, pendingContextCaptures: heldCaptures.length,
        runs: [...runs.values()].map((run) => ({ ...runState(run), conversationId: run.conversationId,
          requestId: run.requestId, clientThreadId: run.clientThreadId, fixtureStage: run.fixtureStage || null,
          ...(run.fixtureApprovalOffer ? { fixtureApprovalOffer: run.fixtureApprovalOffer } : {}),
          ...(run.fixtureContextTools ? { fixtureContextTools: [...run.fixtureContextTools] } : {}),
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
        if (claudeFixture && typeof body.claudeCapabilities === 'boolean') claudeContextAvailable = body.claudeCapabilities;
        if (Object.hasOwn(body, 'claudeReader') || Object.hasOwn(body, 'claudeCapacityKnown')) {
          if (!claudeReaderFixture) contextError('CLAUDE_CONTEXT_READER_UNSUPPORTED', 'Reader scenarios require their explicit synthetic fixture gate');
          if (typeof body.claudeReader === 'boolean') claudeReaderAvailable = body.claudeReader;
          if (typeof body.claudeCapacityKnown === 'boolean') claudeCapacityKnown = body.claudeCapacityKnown;
        }
      }
      else if (body.phase === 'capture') {
        const index = heldCaptures.findIndex(item => item.clientThreadId === body.clientThreadId);
        if (index < 0) return json(res, 409, { error: 'No held capture for that fixture wire thread' });
        const pending = heldCaptures.splice(index, 1)[0];
        if (pending.authority) {
          try { assertClaudeContextCurrent(pending.authority); }
          catch (error) {
            json(pending.res, error.httpStatus, { code: error.code, error: error.message });
            throw error;
          }
        }
        json(pending.res, 200, pending.result);
      }
      else {
        const run = runs.get(body.runId);
        if (!run) return json(res, 404, { error: 'Unknown fixture run' });
        contextPhase(run, body.phase);
      }
      return json(res, 200, { ok: true, fixtureOnly: true });
    }
    if (req.method === 'GET' && url.pathname === '/context/capabilities' && claudeFixture) {
      if (!claudeContextAvailable) return json(res, 404, { code: 'CLAUDE_CONTEXT_UNSUPPORTED', error: 'B2 context capability unavailable' });
      const routing = Object.fromEntries(url.searchParams);
      if (Object.keys(routing).some(key => !['engineId', 'engineProfileId', 'clientThreadId', 'conversationId'].includes(key))) contextError('INVALID_CONTEXT_ROUTING', 'Unknown context routing field', 400);
      const authority = claudeContextRouting(routing);
      return json(res, 200, { contract: 'egdesk-context-b2', engineId: authority.engineId, engineProfileId: authority.engineProfileId,
        selectedAttachments: true, immutableRead: true, nativeReader: claudeReaderAvailable && claudeCapacityKnown,
        ...(claudeReaderFixture ? { largeReader: claudeReaderAvailable && claudeCapacityKnown,
          reader: { ready: claudeReaderAvailable && claudeCapacityKnown, engineId: 'claude',
            code: !claudeReaderAvailable ? 'CLAUDE_CONTEXT_READER_UNSUPPORTED' : !claudeCapacityKnown ? 'ENGINE_CAPACITY_UNKNOWN' : null } } : {}),
        tools: [...CLAUDE_CONTEXT_TOOLS],
        expectedContextScope: expectedClaudeContextScope(authority) });
    }
    if (req.method === 'POST' && url.pathname === '/context/captures') {
      if (!claudeFixture && !authLoggedIn) return json(res, 403, { error: 'Fixture account is signed out' });
      const body = await bodyJson(req);
      let authority;
      if (claudeFixture) {
        if (!claudeContextAvailable) return refuseClaudeContext(res, url.pathname);
        if (Object.keys(body).some(key => !['engineId', 'engineProfileId', 'clientThreadId', 'conversationId', 'expectedContextScope', 'attachments'].includes(key))) contextError('INVALID_CONTEXT_ROUTING', 'Unknown context capture field', 400);
        authority = claudeContextRouting(body);
        assertClaudeContextExpectation(body, authority);
      }
      if (failNextCapture) { failNextCapture = false; observed.contextCaptureFailures++; return json(res, 503, { code: 'QA_CAPTURE_FAILED', error: 'Explicit fixture capture failure' }); }
      const result = context.captureBatch(body, authority?.owner || accountVariant, { directOnly: claudeFixture });
      if (claudeFixture) observed.captures.push({ request: structuredClone(body), captures: structuredClone(result.captures) });
      if (holdNextCapture) {
        holdNextCapture = false;
        heldCaptures.push({ res, result, clientThreadId: body.clientThreadId, ...(authority ? { authority } : {}) });
        return;
      }
      return json(res, 200, result);
    }
    const captureRoute = url.pathname.match(/^\/context\/captures\/([\da-f-]{36})$/i);
    if (req.method === 'GET' && captureRoute) {
      if (!claudeFixture && !authLoggedIn) return json(res, 403, { error: 'Fixture account is signed out' });
      const routingKeys = claudeFixture ? ['engineId', 'engineProfileId', 'clientThreadId', 'conversationId'] : [];
      if ([...url.searchParams.keys()].some(key => !['startLine', 'endLine', 'packetId', ...routingKeys].includes(key))) return json(res, 400, { error: 'Unknown inspector query field' });
      const authority = claudeFixture ? claudeContextRouting(Object.fromEntries(url.searchParams)) : null;
      const options = Object.fromEntries(['startLine', 'endLine'].filter(key => url.searchParams.has(key)).map(key => [key, Number(url.searchParams.get(key))]));
      if (url.searchParams.has('packetId')) options.packetId = url.searchParams.get('packetId');
      return json(res, 200, context.inspect(captureRoute[1], options, authority?.owner || accountVariant, authority?.clientThreadId, authority?.conversationId));
    }
    if (req.method === 'POST' && url.pathname === '/__qa/release') {
      if (req.headers['x-egdesk-qa-token'] !== token) return json(res, 403, { error: 'Fixture token required' });
      const body = await bodyJson(req);
      const run = runs.get(body.runId);
      if (!run) return json(res, 404, { error: 'Unknown fixture run' });
      if (body.phase === 'claude-rate-rejected' && run.engineId === 'claude' && run.fixtureStage === 'claude-rate-warning') claudeRateLimit(run, true);
      else if (body.phase === 'message' && run.fixtureStage === 'streaming-visible') run.releaseMessage();
      else if (body.phase === 'approval' && run.fixtureStage === 'approval-reply-sent') {
        const approvalId = run.pendingApprovals[0].approvalId;
        run.pendingApprovals = [];
        envelope(run, 'approval.resolved', { approvalId });
        run.fixtureStage = 'approval-resolved';
      } else if (body.phase === 'userInput' && run.fixtureStage === 'user-input-reply-sent') resolveUserInput(run);
      else if (body.phase === 'subagent' && run.fixtureStage === 'subagents-visible') run.settleSubAgents();
      else if (body.phase === 'run' && ['message-completed', 'approval-resolved', 'user-input-resolved', 'subagents-settled',
        'stop-requested'].includes(run.fixtureStage)) {
        if (!run.stopRequested) run.finishFixture?.();
        run.status = run.stopRequested || run.approvalDecision === 'cancel' ? 'interrupted' : 'completed';
        run.pendingUserInputs = []; // finish clears unanswered questions; run.completed tells the UI.
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
          if (!pending.res.destroyed) {
            try {
              if (pending.authority) assertClaudeContextCurrent(pending.authority);
              json(pending.res, 200, pending.snapshot);
            } catch (error) { json(pending.res, error.httpStatus, { code: error.code, error: error.message }); }
          }
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
        if (claudeFixture && body.engineId === 'claude') {
          for (const run of runs.values()) if (run.fixtureReaderRequired && activeRun(run)) {
            for (const capture of run.contextCaptures) context.abandonReader(capture.sourceId, run, run.fixtureOwner);
          }
          claudeAccountVariant = body.variant; claudeEpoch++;
          broadcastFixtureEvent({ type: 'engine.status', v: 1, engines: engineRows(), ts: Date.now() });
        } else {
          accountVariant = body.variant;
          broadcastFixtureEvent({ type: 'auth.status', v: 1, provider: 'codex', status: authSnapshot() });
        }
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
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, {
      ok: true, fixture: true, profile, host: HOST, port: PORT, origin, appServerReady: !claudeFixture && !modelFreeFixture,
      ...(claudeFixture ? { claudeFixture: true, claudeReaderFixture, providerTurns: 0, engines: engineRows() } : {}) });
    if (req.method === 'GET' && (url.pathname === '/v1/state' || url.pathname === '/auth/status')) {
      if (authLookupFails) return json(res, 503, { error: 'QA account refresh temporarily unavailable' });
      const auth = authSnapshot();
      return json(res, 200, url.pathname === '/auth/status' ? auth : {
        protocolVersion: 2, provider: 'codex', appServerReady: !claudeFixture && !modelFreeFixture, auth,
        ...(portableTransferFixture ? { deskStorageReady: portableTransferFixture.snapshot().deskReadiness.storeOpen } : {}),
        ...(claudeFixture ? { engines: engineRows() } : {}),
        capabilities: { auth: ['status'], chat: ['send', 'stream', 'interrupt', 'resume', 'user-input', 'subagent-status'] },
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
      if (claudeFixture) res.write(`event: codex\ndata: ${JSON.stringify({ type: 'engine.status', v: 1,
        engines: engineRows(), ts: Date.now() })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/chat/state') {
      const owned = [...runs.values()].find(run => run.conversationId === url.searchParams.get('conversationId'));
      if (owned?.fixtureContextAuthority) assertClaudeContextCurrent(owned.fixtureContextAuthority);
      return json(res, 200, conversationState(url.searchParams.get('conversationId') || ''));
    }
    if (req.method === 'POST' && url.pathname === '/chat/resume') {
      const body = await bodyJson(req);
      if (claudeFixture && (body.engineId !== 'claude' || ![...runs.values()].some(run =>
        run.engineId === 'claude' && run.conversationId === body.conversationId && run.clientThreadId === body.clientThreadId
        && (!run.fixtureOwner || run.fixtureOwner === claudeOwner())))) {
        return json(res, 409, { code: 'ENGINE_MISMATCH', error: 'Resume must preserve the owned Claude conversation and client binding' });
      }
      observed.resumes.push({ conversationId: body.conversationId, clientThreadId: body.clientThreadId || null,
        ...(claudeFixture ? { engineId: body.engineId } : {}) });
      const snapshot = conversationState(body.conversationId || '');
      const authority = [...runs.values()].find(run => run.conversationId === body.conversationId)?.fixtureContextAuthority;
      if (authority) assertClaudeContextCurrent(authority);
      if (holdResume) { observed.heldResumes++; heldResumes.push({ res, snapshot, authority }); return; }
      return json(res, 200, snapshot);
    }
    if (req.method === 'POST' && url.pathname === '/chat/send') {
      const body = await bodyJson(req);
      assertOrdinarySend(body);
      // Origin/Task real handlers already ran above. Ordinary synthetic modes
      // have no project authority: validate the exact observed-none identity,
      // never silently discard expectedRoomProject or accept a connected target.
      const expectedRoomProject = assertQaEmptyProjectSend(body);
      if (expectedRoomProject) {
        const expectations = observed.roomProjectExpectations ||= [];
        if (expectations.length >= 512) return json(res, 429, { code: 'QA_TRACE_LIMIT', error: 'Bounded room-project expectation trace is full' });
        expectations.push({ clientThreadId: body.clientThreadId, expectedRoomProject, result: null, contract: 'fixture-owned-no-project' });
      }
      if (claudeFixture) {
        if (body.engineId !== 'claude' || body.profileEnabled !== false) return json(res, 409, {
          code: 'ENGINE_UNAVAILABLE', error: 'This isolated fixture only accepts ordinary Claude turns; Codex is offline' });
        claudeContextRouting(body);
        if (['selectedSources', 'attachments', 'briefingInputs', 'inputSources'].some(key => body[key]?.length)
            || body.contextResolution || body.browserToolSelection) return refuseClaudeContext(res, url.pathname);
        if (body.contextCapabilities?.reader === true && !claudeReaderAvailable) contextError('CLAUDE_CONTEXT_READER_UNSUPPORTED', 'Claude Smart Read is temporarily unsupported');
        if (body.contextCapabilities && (Object.keys(body.contextCapabilities).some(key => !['read', 'reader', 'publishBriefing'].includes(key))
          || body.contextCapabilities.publishBriefing === true || body.contextCapabilities.read !== true)) contextError('CONTEXT_TOOL_UNSUPPORTED', 'Only explicit immutable Context reads are allowed');
        if (body.conversationId && ![...runs.values()].some(run => run.conversationId === body.conversationId
            && run.engineId === 'claude' && run.clientThreadId === body.clientThreadId)) return json(res, 409, {
          code: 'ENGINE_MISMATCH', error: 'Unknown Claude fixture conversation binding' });
      } else if (body.engineId && body.engineId !== 'codex') return json(res, 409, { code: 'ENGINE_UNAVAILABLE', error: 'Claude fixture is not enabled' });
      const matchedScenario = body.message.match(SCENARIO)?.[1]
        || (runOutputsFixture && body.message.match(/^EGDESK_QA_(RUN_OUTPUTS(?:_LOST)?)\b/)?.[1]);
      if (!matchedScenario) {
        return json(res, 400, { error: 'Fixture accepts only explicit EGDESK_QA_* messages' });
      }
      let scenario = matchedScenario;
      if (scenario.startsWith('CLAUDE_') !== claudeFixture) return json(res, 400, { error: 'Scenario belongs to another fixture mode' });
      if (scenario === 'CLAUDE_CONTEXT_BLOCKED') return refuseClaudeContext(res, url.pathname);
      if (claudeFixture && (scenario === 'CLAUDE_CONTEXT' || body.contextSnapshotIds?.length)) {
        if (!claudeContextAvailable) return refuseClaudeContext(res, url.pathname);
        if (scenario !== 'CLAUDE_CONTEXT') contextError('CLAUDE_CONTEXT_UNSUPPORTED', 'Context requires its explicit fixture scenario');
        assertClaudeContextExpectation(body, claudeContextRouting(body));
        context.validateDirect(body.contextSnapshotIds, body.clientThreadId, claudeOwner(), { readerAvailable: claudeReaderAvailable });
        if (context.requiresReader(body.contextSnapshotIds, body.clientThreadId, claudeOwner())) {
          if (!claudeCapacityKnown) contextError('ENGINE_CAPACITY_UNKNOWN', 'Synthetic capacity is unknown; no model window was assumed');
          if (body.contextCapabilities?.reader !== true) contextError('CLAUDE_CONTEXT_READER_UNSUPPORTED', 'This send did not retain the verified Reader capability');
          if (body.contextSnapshotIds.length !== 1) contextError('CONTEXT_FIXTURE_UNSUPPORTED', 'Bounded Reader fixture requires exactly one explicit source');
        }
      }
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
        runId, answerId: `${conversationId}/${runId}`, status: claudeFixture ? 'inProgress' : 'running', stopRequested: false,
        ...(claudeFixture ? { engineId: 'claude', engine: { id: 'claude', version: '2.1.0', engineProfileId: 'claude-default' } } : {}),
        messages: new Map([[`${runId}-native-user`, { id: `${runId}-native-user`, role: 'user',
          text: body.message, content: body.message, status: 'completed', createdAt: Date.now() }]]),
        activities: new Map(), artifacts: [], pendingApprovals: [], pendingUserInputs: [], subAgents: [], error: null };
      if (scenario === 'CONTEXT') {
        if (Object.keys(body.contextCapabilities || {}).length !== 3
            || !['read', 'reader', 'publishBriefing'].every(key => body.contextCapabilities[key] === true)) throw new Error('Explicit context capabilities required');
        run.fixtureOwner = accountVariant;
        run.contextCaptures = context.bind(body.contextSnapshotIds, run, accountVariant);
        run.contextEvents = [];
        run.fixtureStage = 'context-bound';
      }
      if (scenario === 'CLAUDE_CONTEXT') {
        run.fixtureOwner = claudeOwner();
        run.fixtureContextAuthority = claudeContextRouting(body);
        run.contextCaptures = context.bind(body.contextSnapshotIds, run, run.fixtureOwner, { directOnly: true, readerAvailable: claudeReaderAvailable });
        run.fixtureReaderRequired = context.requiresReader(body.contextSnapshotIds, body.clientThreadId, run.fixtureOwner);
        run.contextEvents = [];
        run.fixtureContextTools = [...CLAUDE_CONTEXT_TOOLS];
        run.fixtureStage = 'context-bound';
      }
      runs.set(runId, run);
      const observedSend = { ...body, scenario, runId, acceptedAt: Date.now() };
      observed.sends.push(observedSend);
      envelope(run, 'run.started'); // Deliberately before the POST response.
      if (['CONTEXT', 'CLAUDE_CONTEXT'].includes(scenario)) envelope(run, 'context.bound', { captures: run.contextCaptures });
      // Chat72 may refresh partial history as soon as running is observed,
      // before this deliberately delayed ACK. Its STOP message must already
      // exist, and the ACK must not restart it or discard a later delta.
      if (scenario === 'STOP') stopScenario(run);
      setTimeout(() => {
        json(res, 202, { accepted: true, conversationId, requestId, runId, answerId: run.answerId });
        observedSend.respondedAt = Date.now();
        if (runOutputsFixture?.accepts(scenario)) runOutputsFixture.seed(run);
        else if (claudeFixture) claudeScenario(run);
        else if (scenario === 'COMPLETE') completeScenario(run);
        else if (scenario === 'TEXT_ONLY') textOnlyScenario(run);
        else if (scenario === 'STOP') { /* Already initialized before ACK. */ }
        else if (scenario === 'APPROVAL') approvalScenario(run);
        else if (scenario === 'USER_INPUT') userInputScenario(run);
        else if (scenario === 'SUBAGENT') subAgentScenario(run);
        else if (scenario !== 'CONTEXT') unavailableScenario(run);
      }, 80);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/chat/interrupt') {
      const body = await bodyJson(req);
      const run = runs.get(body.runId);
      if (!run || run.conversationId !== body.conversationId || !activeRun(run)) {
        return json(res, 404, { accepted: false, stopRequested: false });
      }
      if (run.engineId === 'claude') {
        if (body.engineId != null && body.engineId !== 'claude') contextError('ENGINE_MISMATCH', 'Stop belongs to another engine', 403);
        if (run.fixtureContextAuthority) assertClaudeContextCurrent(run.fixtureContextAuthority);
        if (run.stopRequested) return json(res, 409, { accepted: false, stopRequested: true, code: 'QA_STOP_ALREADY_REQUESTED' });
        if (run.fixtureReaderRequired) for (const capture of run.contextCaptures) {
          context.abandonReader(capture.sourceId, run, run.fixtureOwner);
          const details = { sourceId: capture.sourceId, code: 'READ_CANCELLED', fixtureOnly: true };
          for (const name of ['reader.failed', 'context.read.failed']) {
            envelope(run, name, details);
            run.contextEvents.push({ event: name, details: structuredClone(details) });
          }
        }
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
          approval.status !== 'pending' || runConnection(run) !== 'ready' || !activeRun(run)) {
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
    if (req.method === 'POST' && url.pathname === '/chat/user-input') {
      const body = await bodyJson(req);
      const invalid = () => json(res, 400, { accepted: false, code: 'INVALID_USER_INPUT_ANSWER', error: 'Answer does not match the pending questions' });
      if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some(key => !['userInputId', 'conversationId', 'runId', 'action', 'answers'].includes(key))) return invalid();
      // Mirrors the bridge: only skip is a safety response that bypasses account lookup.
      if (body.action !== 'skip' && authLookupFails) return json(res, 503, { accepted: false, code: 'QA_AUTH_LOOKUP_FAILED', error: 'QA account refresh temporarily unavailable' });
      if (!claudeFixture && connection !== 'ready') return json(res, 503, { accepted: false, code: 'BRIDGE_OFFLINE', error: 'Fixture runtime is offline' });
      const run = runs.get(body.runId);
      const input = run?.pendingUserInputs.find(item => item.userInputId === body.userInputId);
      if (!run || run.conversationId !== body.conversationId || !input || input.status !== 'pending' || !activeRun(run)) {
        return json(res, 409, { accepted: false, code: 'STALE_USER_INPUT', error: 'Question no longer belongs to this pending run' });
      }
      const answers = userInputAnswers(input, body);
      if (!answers) return invalid();
      observed.userInputs.push({ userInputId: input.userInputId, conversationId: run.conversationId, runId: run.runId,
        action: body.action, answers, repliedAt: Date.now() });
      input.status = 'replySent';
      seq++;
      run.fixtureStage = 'user-input-reply-sent';
      run.userInputAction = body.action;
      return json(res, 200, { accepted: true, userInputId: input.userInputId, conversationId: run.conversationId, runId: run.runId, status: 'replySent' });
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
    if (claudeFixture && /^(?:CONTEXT_|CLAUDE_CONTEXT_|UNSUPPORTED_SOURCE_FORMAT|ENGINE_CAPACITY_UNKNOWN)/.test(error.code || '')) {
      observed.contextRefusals.push({ route: new URL(req.url, origin).pathname, code: error.code });
    }
    return json(res, error.httpStatus || 400, { error: error.message, ...(error.code ? { code: error.code } : {}) });
  }
};
const dispose = () => {
  if (originFileReady) {
    originFileClosing = true;
    if (!originFileClosePromise) originFileClosePromise = originFileReady.then(value => value.dispose());
    return originFileClosePromise;
  }
  if (taskGateReady) {
    taskGateClosing = true;
    if (!taskGateClosePromise) taskGateClosePromise = taskGateReady.then(value => value.dispose());
    return taskGateClosePromise;
  }
  for (const run of runs.values()) if (['armed', 'pending'].includes(run.stopAckHold?.state)) expireStopHold(run, 'disposed');
  runOutputsFixture?.dispose();
  portableTransferFixture?.dispose();
  return projectFileFixture?.dispose();
};
return { handler, dispose, ...(taskGateReady || originFileReady ? { ready: taskGateReady || originFileReady } : {}), info: { kind: 'egdesk-qa-fixture-ready', host: HOST, port: PORT,
  ...(projectFileFixture ? projectFileFixture.info : {}),
  ...(claudeFixture ? { claudeFixture: true, claudeReaderFixture, providerTurns: 0 } : {}),
  ...(runOutputsFixture ? { runOutputsFixture: true, providerTurns: 0 } : {}),
  ...(portableTransferFixture ? { portableTransferFixture: true, providerTurns: 0 } : {}),
  ...(taskGateEnabled ? { taskGateFixture: true, providerTurns: 0 } : {}),
  ...(originFileEnabled ? { chatOriginFileFixture: true, providerTurns: 0 } : {}),
  profile, artifactPath, streamId, isolation, scope: 'QA-only transformed copies, no shipped runtime replacement' } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const params = new Map();
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!process.argv[i]?.startsWith('--') || !process.argv[i + 1] || params.has(process.argv[i])) throw new Error('Expected one --profile /path');
    params.set(process.argv[i], process.argv[i + 1]);
  }
  if (process.env.EGDESK_QA_FIXTURE_TRANSPORT !== '1' || params.size !== 1 || !params.has('--profile')) {
    throw new Error('Fixture CLI requires EGDESK_QA_FIXTURE_TRANSPORT=1 and only --profile /canonical/path');
  }
  const fixture = createQaFixtureTransport({ profile: params.get('--profile'), token: process.env.EGDESK_QA_FIXTURE_TOKEN });
  await fixture.ready;
  const server = http.createServer(fixture.handler);
  server.on('close', async () => { try { await fixture.dispose(); } catch (error) {
    process.stderr.write(`Fixture disposal failed: ${error.message}\n`); process.exitCode = 1;
  } });
  server.listen(fixture.info.port, fixture.info.host, () => process.stdout.write(`${JSON.stringify(fixture.info)}\n`));
}
