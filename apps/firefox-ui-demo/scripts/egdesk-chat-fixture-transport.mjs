#!/usr/bin/env node
// Developer-only HTTP/SSE fixture. Never imported by the shipped bridge.
// Main prepares an isolated QA overlay and explicitly starts this on its own
// port before launching QA Firefox. The personal bridge :39218 is never used.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { isDeepStrictEqual } from 'node:util';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { assertOrdinarySend } from './egdesk-chat-qa-contract.sys.mjs';
import { createQaContextFixture, seedQaSourceChangeScene, seedQaBriefingCommentsScene } from './egdesk-context-qa-fixture.mjs';
import { observeQaFixtureFile } from './egdesk-context-qa-contract.mjs';
import { qaBridgeConfig, validateQaFixtureIsolation } from './egdesk-qa-fixture-isolation.mjs';
import { projectFileFixtureEnabled } from './egdesk-qa-fixture-isolation.mjs';
import { createProjectFileFixture } from './egdesk-project-file-fixture.mjs';
import { chatRunOutputsFixtureEnabled, createChatRunOutputsFixture } from './egdesk-chat-run-outputs-fixture.mjs';
import { portableTransferFixtureEnabled, createPortableTransferFixture } from './egdesk-portable-transfer-fixture.mjs';
import { taskGateFixtureEnabled, createTaskGateFixture, assertQaEmptyProjectSend } from './egdesk-task-gate-fixture.mjs';
import { chatOriginFileFixtureEnabled, createChatOriginFileFixture } from './egdesk-chat-origin-file-fixture.mjs';
import { routePermissionRequest } from '../helper/claude-engine-permissions.mjs'; // Pure shape translation only.
import { guardBridgeRequest, createChatHttpHandler } from '../helper/codex-bridge-http.mjs';
import { readEGDeskFileBody } from '../helper/egdesk-file-http.mjs';
import { ContextRuntime } from '../helper/egdesk-context-runtime.mjs';
import { createDayOneContextFixture } from './egdesk-dayone-context-fixture.mjs';
import { createContextHttpHandler } from '../helper/egdesk-context-http.mjs';

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
// in-memory requests; an explicit QA caller/CLI owns any loopback listener.
// Optional Memo producer: one immutable, synthetic request in one fresh QA
// session. It reuses COMPLETE and its existing message/run release phases.
function memoRoundTripOption(value, env, token) {
  if (value === undefined) return null;
  const fail = () => { throw new Error('Memo one-shot requires an exact synthetic request, exclusive offline QA and a lease of at most five minutes'); };
  if (env.EGDESK_QA_FIXTURE_TRANSPORT !== '1' || env.EGDESK_QA_REAL_TURN !== '0'
      || (env.EGDESK_QA_FIXTURE_TOKEN != null && env.EGDESK_QA_FIXTURE_TOKEN !== token)) fail();
  if (Object.entries(env).some(([key, flag]) => (/^EGDESK_QA_.*_FIXTURE$/.test(key)
      || ['EGDESK_QA_STATE_FIXTURES', 'EGDESK_QA_CONTEXT_SOURCE_CHANGE_SEED', 'EGDESK_QA_BRIEFING_COMMENTS_SEED',
        'EGDESK_QA_BROWSER_NEGATIVE', 'EGDESK_QA_BROWSER_RELAY'].includes(key)) && flag != null && flag !== '' && flag !== '0')) fail();
  const keys = ['sessionId', 'caseId', 'memoId', 'agentId', 'question', 'deadlineAt', 'send'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length
      || keys.some(key => !Object.hasOwn(value, key))) fail();
  const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(value);
  if (typeof value.sessionId !== 'string' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value.sessionId)
      || ![value.caseId, value.memoId, value.agentId].every(id)
      || typeof value.question !== 'string' || value.question.length > 500 || /[\r\n\0]/.test(value.question)
      || !value.question.startsWith('SYNTHETIC ') || !value.question.includes(`[${value.caseId}]`)
      || !Number.isSafeInteger(value.deadlineAt) || value.deadlineAt <= Date.now() || value.deadlineAt > Date.now() + 300000) fail();
  let send;
  try { send = JSON.parse(JSON.stringify(value.send)); } catch { fail(); }
  if (!send || typeof send !== 'object' || Array.isArray(send) || !isDeepStrictEqual(send, value.send)
      || typeof send.message !== 'string' || send.message.length > 4000 || send.message.includes('\0')
      || !send.message.endsWith(`\n\n질문: ${value.question}`) || !id(send.clientThreadId)
      || send.profileEnabled !== true || (send.engineId !== undefined && send.engineId !== 'codex')
      || ['requestId', 'conversationId', 'projectTarget', 'executionPolicy', 'stateless', 'selectedSources',
        'attachments', 'briefingInputs', 'inputSources', 'browserTransportId', 'contextResolution'].some(key => Object.hasOwn(send, key))
      || (send.contextSnapshotIds !== undefined && (!Array.isArray(send.contextSnapshotIds) || send.contextSnapshotIds.length))) fail();
  const header = send.message.split('\n\n')[0];
  if (header !== `[메모 · ${value.memoId}]` && header.match(/^\[메모 #[1-9]\d* · ([A-Za-z0-9_.:-]+)\]$/)?.[1] !== value.memoId) fail();
  const stored = send.profileId === value.agentId && !Object.hasOwn(send, 'agentProfile');
  const legacy = send.agentProfile?.id === value.agentId && !Object.hasOwn(send, 'profileId');
  if ((!stored && !legacy) || (send.profileRevision !== undefined && (!Number.isSafeInteger(send.profileRevision) || send.profileRevision < 1))) fail();
  return Object.freeze({ ...value, send, messageSha256: createHash('sha256').update(send.message).digest('hex') });
}

export function createQaFixtureTransport({ profile: profilePath, token, env = process.env, memoRoundTrip, memoRuntimeRoomId }) {
const memoCase = memoRoundTripOption(memoRoundTrip, env, token);
const memoRuntime = memoRuntimeRoomId !== undefined;
const runtimeBindingError = () => { throw new Error('Memo runtime binding requires one explicit native nonce for the declared synthetic room, within its original lease'); };
if (memoRuntime && (!memoCase || typeof memoRuntimeRoomId !== 'string'
    || !/^qa-[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(memoRuntimeRoomId)
    || memoCase.send.clientThreadId !== memoRuntimeRoomId
    || !isDeepStrictEqual(memoCase.send.expectedRoomProject, {
      roomId: memoRuntimeRoomId, status: 'none', source: null, boardId: null, projectId: null, rootId: null,
    }))) runtimeBindingError();
let memoExpectedSend = memoCase?.send, memoRuntimeArmed = !memoRuntime;
let memoUsed = false, memoRunId = null, memoClosed = false;
const memoUnavailable = () => memoClosed ? 503 : Date.now() >= memoCase.deadlineAt ? 410 : 0;
const memoEvidence = () => ({ sessionId: memoCase.sessionId, caseId: memoCase.caseId, memoId: memoCase.memoId,
  agentId: memoCase.agentId, clientThreadId: memoExpectedSend.clientThreadId, deadlineAt: memoCase.deadlineAt,
  ...(memoRuntime ? { runtimeRoomId: memoRuntimeRoomId, runtimeBindingArmed: memoRuntimeArmed } : {}),
  messageSha256: memoCase.messageSha256, used: memoUsed, runId: memoRunId, closed: memoClosed });
// This capability never enters HTTP state. The local QA owner first observes
// its ready room, then supplies only the native binding; no request learns it.
const memoRuntimeBinding = memoRuntime ? Object.freeze({ arm(...args) {
  if (args.length !== 1 || memoUnavailable() || memoRuntimeArmed || memoUsed) runtimeBindingError();
  const binding = args[0], prefix = `${memoRuntimeRoomId}-binding-`;
  if (typeof binding !== 'string' || binding.length > 192 || !binding.startsWith(prefix)) runtimeBindingError();
  const nonce = binding.slice(prefix.length);
  // chatBindingNonce: crypto.randomUUID(), or base36 Date.now()-Math.random().
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(nonce)
      && !/^[0-9a-z]{8,11}-[0-9a-z]{0,11}$/.test(nonce)) runtimeBindingError();
  memoExpectedSend = { ...memoCase.send, clientThreadId: binding,
    expectedRoomProject: { ...memoCase.send.expectedRoomProject, roomId: binding } };
  memoRuntimeArmed = true;
  return Object.freeze(memoEvidence());
} }) : null;
if (env.EGDESK_QA_FIRST_CODEX_AUTH_FIXTURE != null && !['0', '1'].includes(env.EGDESK_QA_FIRST_CODEX_AUTH_FIXTURE)) {
  throw new Error('Invalid first Codex auth fixture gate');
}
const firstCodexAuthFixture = env.EGDESK_QA_FIRST_CODEX_AUTH_FIXTURE === '1';
// This describes the first-auth fixture's design, not measured process or
// network activity. OS isolation is supplied and checked by the caller.
const firstCodexAuthBoundary = Object.freeze({ kind: 'first-codex-auth-fixture-boundary-v1',
  auth: 'synthetic-fixture', chat: 'synthetic-fixture', providerIntegration: 'none-configured-for-first-auth',
  providerTurnObservation: 'not-instrumented', nativeProcessSpawnObservation: 'not-instrumented' });
if (firstCodexAuthFixture) {
  if (env.EGDESK_QA_FIXTURE_TRANSPORT !== '1' || env.EGDESK_QA_REAL_TURN !== '0') {
    throw new Error('First Codex auth fixture requires isolated transport and explicit real-turn zero');
  }
  const conflict = Object.entries(env).find(([key, value]) => key !== 'EGDESK_QA_FIRST_CODEX_AUTH_FIXTURE'
    && (/^EGDESK_QA_.*_FIXTURE$/.test(key) || ['EGDESK_QA_STATE_FIXTURES',
      'EGDESK_QA_CONTEXT_SOURCE_CHANGE_SEED', 'EGDESK_QA_BRIEFING_COMMENTS_SEED',
      'EGDESK_QA_BROWSER_NEGATIVE', 'EGDESK_QA_BROWSER_RELAY'].includes(key))
    && value != null && value !== '' && value !== '0');
  if (conflict) throw new Error(`First Codex auth fixture is exclusive; conflicts with ${conflict[0]}`);
}
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
if (env.EGDESK_QA_CONTEXT_SOURCE_CHANGE_SEED != null && !['0', '1'].includes(env.EGDESK_QA_CONTEXT_SOURCE_CHANGE_SEED)) throw new Error('Invalid source-change seed gate');
const sourceChangeSeedEnabled = env.EGDESK_QA_CONTEXT_SOURCE_CHANGE_SEED === '1';
if (env.EGDESK_QA_BRIEFING_COMMENTS_SEED != null && !['0', '1'].includes(env.EGDESK_QA_BRIEFING_COMMENTS_SEED)) throw new Error('Invalid Briefing comments seed gate');
const briefingCommentsSeedEnabled = env.EGDESK_QA_BRIEFING_COMMENTS_SEED === '1';
if (env.EGDESK_QA_BRIEFING_MULTI_TARGET != null && !['0', '1'].includes(env.EGDESK_QA_BRIEFING_MULTI_TARGET)) throw new Error('Invalid Briefing multi-target seed gate');
const briefingMultiTargetEnabled = env.EGDESK_QA_BRIEFING_MULTI_TARGET === '1';
if (briefingMultiTargetEnabled && !briefingCommentsSeedEnabled) throw new Error('Briefing multi-target seed requires the isolated Briefing comments seed');
if (briefingCommentsSeedEnabled && (sourceChangeSeedEnabled || env.EGDESK_QA_STATE_FIXTURES !== '1' || env.EGDESK_QA_REAL_TURN !== '0'
  || claudeFixture || runOutputsEnabled || taskGateEnabled || originFileEnabled || projectFileFixtureEnabled(env) || portableTransferFixtureEnabled(env))) {
  throw new Error('Briefing comments seed requires its exclusive core state fixture and real-turn zero');
}
if (sourceChangeSeedEnabled && (env.EGDESK_QA_STATE_FIXTURES !== '1' || env.EGDESK_QA_REAL_TURN !== '0'
  || claudeFixture || runOutputsEnabled || taskGateEnabled || originFileEnabled || projectFileFixtureEnabled(env) || portableTransferFixtureEnabled(env))) {
  throw new Error('Source-change seed requires the separate core state fixture and real-turn zero');
}
if (originFileEnabled && fs.lstatSync(path.join(profile, 'prefs.js'), { throwIfNoEntry: false })) {
  throw new Error('Origin File requires a fresh prefs-less owned QA profile');
}
if (env.EGDESK_QA_PROJECT_FILE_WATCH != null && !['0', '1'].includes(env.EGDESK_QA_PROJECT_FILE_WATCH)) {
  throw new Error('Invalid project File watcher opt-in');
}
if (env.EGDESK_QA_PROJECT_FILE_WATCH === '1' && !projectFileFixtureEnabled(env)) {
  throw new Error('Project File watcher requires its exclusive model-free fixture');
}
const projectFileFixture = projectFileFixtureEnabled(env)
  ? createProjectFileFixture({ profile, token, env, broadcast: frame => {
    observed.projectFileWatchBroadcasts ||= [];
    if (observed.projectFileWatchBroadcasts.length >= 128) throw new Error('Project watcher broadcast trace limit');
    observed.projectFileWatchBroadcasts.push({ eventId: frame?.event?.id || null, clients: clients.size });
    broadcastFixtureEvent(frame);
  } }) : null;
const portableTransferFixture = portableTransferFixtureEnabled(env)
  ? createPortableTransferFixture({ profile, token, env }) : null;
const modelFreeFixture = !!(projectFileFixture || portableTransferFixture);
const sourceStatusEnabled = env.EGDESK_QA_STATE_FIXTURES === '1' && !claudeFixture && !modelFreeFixture
  && !runOutputsEnabled && !taskGateEnabled && !originFileEnabled;
if (sourceStatusEnabled && env.EGDESK_QA_REAL_TURN !== '0') throw new Error('Source-state fixtures require explicit real-turn zero');
const artifactRoot = fixture.root;
const artifactPath = fixture.artifactPath;
const context = createQaContextFixture(profile);
let sourceChangeScene = null;
let sourceChangeHistoryHandler = null, sourceChangeClosing = false;
let briefingCommentsHandler = null;
const sourceChangeReady = sourceChangeSeedEnabled || briefingCommentsSeedEnabled
  ? (briefingCommentsSeedEnabled ? seedQaBriefingCommentsScene(profile, context, { multiTarget: briefingMultiTargetEnabled })
    : seedQaSourceChangeScene(profile, context)).then(scene => {
  sourceChangeScene = scene;
  sourceChangeHistoryHandler = createChatHttpHandler(scene.history, () => { throw new Error('No seed auth calls'); });
  if (briefingCommentsSeedEnabled) {
    const runtime = new ContextRuntime({ store: scene.store, getOwnerKey: () => accountVariant,
      getAuthority: hints => { const r = codexContextRouting(hints, { requireConversation: true });
        return { ...r, ownerKey: r.owner }; } });
    briefingCommentsHandler = createContextHttpHandler(runtime, async () => {}, { port: PORT });
  }
  return scene;
}) : null;
if (sourceChangeReady) void sourceChangeReady.catch(() => {});
let failNextCapture = false;
let holdNextCapture = false;
const heldCaptures = [];
const sourceResponses = new Map();
const sourceResponsesInFlight = new Set();
const sourceReceipts = [];
const sourceStatusEvidence = { reads: [], controls: [], releases: [], expired: 0 };
const captureGetEvidence = { releases: [], expired: 0 };
// Count only route-entry attempts in this opt-in synthetic scenario, including
// refused requests. No request bodies, drafts or credentials are retained.
const briefingMultiTargetAttempts = { sendPosts: 0, capturePosts: 0, commentPosts: 0 };
const commentArms = new Map(), commentPending = new Set(), commentReceipts = [], commentRecoveryGets = new Map();

const streamId = randomUUID();
// Per-fixture lifetime expectation, not an owner grant or reusable credential.
const contextScopeKey = randomUUID();
let seq = 0;
let turnCounter = 0;
let connection = claudeFixture || modelFreeFixture ? 'offline' : 'ready';
let authLookupFails = false;
let authLoggedIn = !claudeFixture && !modelFreeFixture && !firstCodexAuthFixture;
let authLoginId = null;
let accountVariant = 'a';
const dayOneEnabled = env.EGDESK_QA_DAYONE_CONTEXT === '1';
if (dayOneEnabled && (env.EGDESK_QA_REAL_TURN !== '0' || memoCase || firstCodexAuthFixture || claudeFixture || modelFreeFixture || runOutputsEnabled || taskGateEnabled || originFileEnabled || sourceChangeReady)) throw new Error('Day One requires an isolated, unseeded synthetic fixture');
const dayOne = dayOneEnabled ? createDayOneContextFixture({ profile, port: PORT, token, broadcast: broadcastFixtureEvent,
  owner: () => authLoggedIn ? `email:qa-account-${accountVariant}@egdesk.invalid` : null }) : null;
let codexContextEpoch = 0;
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
if (firstCodexAuthFixture) Object.assign(observed, { authBlockedSends: 0, authResults: [],
  chatSendPostAttempts: { total: 0, signedOut: 0, signedIn: 0 } });
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
const contextRoutingKeys = ['engineId', 'engineProfileId', 'clientThreadId', 'conversationId'];
function exactContextQuery(url, extra = []) {
  const keys = [...contextRoutingKeys, ...extra];
  for (const [key, value] of url.searchParams) {
    if (!keys.includes(key) || url.searchParams.getAll(key).length !== 1 || !value.trim() || value.includes('\0') || value.length > 512) {
      contextError('INVALID_CONTEXT_ROUTING', 'Unknown, duplicate or empty context query field', 400);
    }
  }
  return Object.fromEntries(url.searchParams);
}
function codexContextRouting(body, { requireConversation = false } = {}) {
  if (!authLoggedIn) contextError('IDENTITY_REQUIRED', 'Fixture account is signed out', 403);
  if (body.engineId !== 'codex' || body.engineProfileId !== 'codex-default') contextError('ENGINE_MISMATCH', 'Expected the selected Codex engine/profile', 403);
  for (const key of ['clientThreadId', ...(requireConversation || Object.hasOwn(body, 'conversationId') ? ['conversationId'] : [])]) {
    if (!bounded(body[key], 512) || !body[key].trim() || body[key].includes('\0')) contextError('INVALID_CONTEXT_ROUTING', `Explicit ${key} required`, 400);
  }
  if (body.conversationId && ![...runs.values(), ...(sourceChangeScene?.identities || [])].some(run =>
    run.conversationId === body.conversationId && run.clientThreadId === body.clientThreadId
    && (!run.engineId || run.engineId === 'codex') && run.fixtureOwner === accountVariant)) {
    contextError('CONTEXT_THREAD_MISMATCH', 'Context route belongs to another conversation/account', 403);
  }
  return { engineId: 'codex', engineProfileId: 'codex-default', clientThreadId: body.clientThreadId,
    ...(body.conversationId ? { conversationId: body.conversationId } : {}), owner: accountVariant, epoch: codexContextEpoch };
}
const sourceResponseKey = r => JSON.stringify([r.owner, r.epoch, ...contextRoutingKeys.map(k => r[k]), r.sourceId]);
const captureResponseKey = r => JSON.stringify(['capture-get', r.owner, r.epoch, ...contextRoutingKeys.map(k => r[k]),
  r.sourceId, r.startLine, r.endLine]);
const sourceResponseCount = captureGet => [...sourceResponses.values()]
  .filter(entry => (entry.kind === 'capture-get') === captureGet).length;
const sameSourceConversation = (a, b) => ['owner', 'epoch', ...contextRoutingKeys].every(k => a[k] === b[k]);
const publicSourceRoute = r => Object.fromEntries([...contextRoutingKeys, 'sourceId'].map(key => [key, r[key]]));
function forgetSourceResponse(entry) {
  clearTimeout(entry.timer);
  // A delayed close/finish from an old GET must never remove a later hold
  // which happens to use the identical route key.
  if (sourceResponses.get(entry.key) === entry) sourceResponses.delete(entry.key);
}
function createSourceReceipt(entry) {
  // Keep the existing CTX04 retention bound independent of the new capture
  // receipts, while retaining one shared lifecycle and a bounded total.
  const sameKind = receipt => (receipt.kind === 'capture-get') === (entry.kind === 'capture-get');
  if (sourceReceipts.filter(sameKind).length >= 64) {
    const oldestTerminal = sourceReceipts.findIndex(receipt => sameKind(receipt) && receipt.terminalCause !== null);
    if (oldestTerminal < 0) contextError('QA_SOURCE_RECEIPT_LIMIT', 'All bounded source receipts are still live', 429);
    sourceReceipts.splice(oldestTerminal, 1);
  }
  const receipt = { holdId: randomUUID(), armedAt: Date.now(), deadlineAt: entry.deadlineAt,
    requestId: null, R: { ...publicSourceRoute(entry.route), ...(entry.kind === 'capture-get'
      ? { startLine: entry.route.startLine, endLine: entry.route.endLine } : {}) },
    ...(entry.kind === 'capture-get' ? { kind: entry.kind } : {}), account: entry.route.owner, epoch: entry.route.epoch,
    heldSourceId: entry.route.sourceId, receivedAt: null, snapshotHash: null,
    releaseAttemptAt: null, releaseAttempts: 0, writeAttempted: false, endReturnedAt: null,
    responseStatus: null, finishAt: null, closeAt: null, writableFinishedAtClose: null, terminalCause: null };
  sourceReceipts.push(receipt);
  return receipt;
}
function recordSourceResponseSnapshot(entry, snapshot) {
  entry.snapshot = structuredClone(snapshot);
  entry.receipt.snapshotHash = createHash('sha256').update(JSON.stringify(entry.snapshot)).digest('hex');
}
function receiveSourceResponse(entry, res, snapshot) {
  const receipt = entry.receipt;
  entry.res = res;
  sourceResponsesInFlight.add(entry);
  receipt.requestId = randomUUID(); receipt.receivedAt = Date.now();
  if (snapshot !== undefined) recordSourceResponseSnapshot(entry, snapshot);
  res.once('finish', () => {
    receipt.finishAt ??= Date.now();
    receipt.terminalCause ??= 'finished';
    sourceResponsesInFlight.delete(entry);
    forgetSourceResponse(entry);
  });
  res.once('close', () => {
    receipt.closeAt ??= Date.now();
    receipt.writableFinishedAtClose ??= res.writableFinished === true;
    // First observed terminal cause wins: a later close cannot turn an
    // expired/account-invalidated/server-closed response into a peer cancel.
    receipt.terminalCause ??= receipt.finishAt !== null ? 'finished' : 'peer-close-before-finish';
    sourceResponsesInFlight.delete(entry);
    forgetSourceResponse(entry);
  });
}
function finishSourceResponse(entry, status, body, cause = null) {
  const receipt = entry.receipt;
  if (receipt?.terminalCause !== null && receipt?.terminalCause !== undefined) return false;
  if (receipt && cause) receipt.terminalCause = cause;
  forgetSourceResponse(entry);
  if (!entry.res) return false;
  if (entry.res.destroyed || entry.res.writableEnded) {
    if (receipt) receipt.terminalCause ??= receipt.finishAt !== null ? 'finished' : 'peer-close-before-finish';
    return false;
  }
  if (receipt) { receipt.writeAttempted = true; receipt.responseStatus = status; }
  try {
    json(entry.res, status, cause && receipt ? { ...body, receipt: structuredClone(receipt) } : body);
    if (receipt) receipt.endReturnedAt = Date.now();
    return true;
  } catch {
    if (receipt) receipt.terminalCause ??= 'write-error';
    entry.res.destroy?.();
    sourceResponsesInFlight.delete(entry);
    return false;
  }
}
function expireSourceResponse(entry) {
  // A queued timer may outlive clearTimeout. It cannot expire an already
  // released/canceled GET or a later same-route entry, even before close fires.
  if (sourceResponses.get(entry.key) !== entry || entry.receipt.terminalCause !== null) return;
  if (entry.kind === 'capture-get') captureGetEvidence.expired++; else sourceStatusEvidence.expired++;
  finishSourceResponse(entry, 504, { code: entry.kind === 'capture-get' ? 'QA_CAPTURE_GET_EXPIRED' : 'QA_SOURCE_STATUS_EXPIRED',
    error: entry.kind === 'capture-get' ? 'Held capture response expired' : 'Held source response expired' }, 'expiry');
}
function sourceControl(body, extra) {
  if (!sourceStatusEnabled) contextError('QA_SOURCE_STATUS_DISABLED', 'Source status controls require the isolated state fixture', 403);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(k => ![...contextRoutingKeys, 'sourceId', ...extra].includes(k))) contextError('INVALID_CONTEXT_ROUTING', 'Exact source status control required', 400);
  const authority = codexContextRouting(body, { requireConversation: true });
  if (!/^[\da-f-]{36}$/i.test(body.sourceId || '')) contextError('INVALID_CONTEXT_ROUTING', 'Stored source ID required', 400);
  const r = { ...authority, sourceId: body.sourceId };
  context.assertSourceScope(r);
  return r;
}
function sourceTrace(kind, value) {
  if (sourceStatusEvidence[kind].length >= 512) contextError('QA_TRACE_LIMIT', 'Bounded source-status trace is full', 429);
  sourceStatusEvidence[kind].push(value);
}

const commentUUID = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const commentKeys = [...contextRoutingKeys, 'briefingId'];
const commentKey = r => JSON.stringify([r.owner, r.epoch, ...commentKeys.map(key => r[key])]);
const commentHash = value => createHash('sha256').update(value).digest('hex');
function commentRoute(body, extra = []) {
  if (!briefingCommentsSeedEnabled) contextError('QA_BRIEFING_COMMENTS_DISABLED', 'Dedicated Briefing comments seed required', 403);
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => ![...commentKeys, ...extra].includes(key))) contextError('INVALID_CONTEXT_ROUTING', 'Exact Briefing route required', 400);
  const r = { ...codexContextRouting(body, { requireConversation: true }), briefingId: body.briefingId };
  if (!commentUUID(r.briefingId)) contextError('INVALID_CONTEXT_ROUTING', 'Briefing UUID required', 400);
  return r;
}
function newCommentEntry(route, options = {}) {
  if (commentReceipts.length >= 64) {
    const terminal = commentReceipts.findIndex(row => row.terminalCause !== null && (!row.recoveryGet || row.recoveryGet.terminalCause !== null));
    if (terminal < 0) contextError('QA_COMMENT_RECEIPT_LIMIT', 'All 64 comment receipts are still live', 429);
    commentReceipts.splice(terminal, 1);
  }
  const receipt = { kind: 'production', method: options.method || 'POST', holdId: options.holdId || null,
    requestId: null, clientRequestId: options.clientRequestId || null,
    R: Object.fromEntries(commentKeys.map(key => [key, route[key]])), account: route.owner, epoch: route.epoch,
    armedAt: options.holdId ? Date.now() : null, receivedAt: null, committedAt: null, commentId: null, seq: null,
    storedHash: null, responseStatus: null, responseHash: null, listed: [], readCompletedAt: null,
    releaseAttemptAt: null, releaseAttempts: 0, writeAttempted: false, endReturnedAt: null,
    finishAt: null, closeAt: null, writableFinishedAtClose: null, terminalCause: null, responseFault: null };
  commentReceipts.push(receipt);
  return { route, key: commentKey(route), receipt, ...options };
}
function forgetComment(entry) {
  clearTimeout(entry.timer);
  clearTimeout(entry.faultTimer);
  if (commentArms.get(entry.key) === entry) commentArms.delete(entry.key);
  commentPending.delete(entry);
  if (entry.recovery) entry.recovery.receipt.terminalCause ??= entry.receipt.terminalCause;
}
function cancelComment(entry, cause) {
  entry.receipt.terminalCause ??= cause;
  forgetComment(entry);
  if (entry.res && !entry.res.destroyed) entry.res.destroy();
}
function receiveComment(entry, res) {
  entry.res = res; entry.receipt.requestId = randomUUID(); entry.receipt.receivedAt = Date.now();
  commentPending.add(entry);
  res.once('finish', () => { entry.receipt.finishAt ??= Date.now(); entry.receipt.terminalCause ??= 'finished'; forgetComment(entry); });
  res.once('close', () => {
    entry.receipt.closeAt ??= Date.now(); entry.receipt.writableFinishedAtClose ??= res.writableFinished === true;
    entry.receipt.terminalCause ??= entry.receipt.finishAt === null ? 'peer-close-before-finish' : 'finished';
    forgetComment(entry);
  });
}
function writeComment(entry) {
  if (entry.receipt.terminalCause !== null) return false;
  if (!entry.res || entry.res.destroyed || entry.res.writableEnded) { cancelComment(entry, 'peer-close-before-finish'); return false; }
  try {
    const current = codexContextRouting(entry.route, { requireConversation: true });
    if (current.owner !== entry.route.owner || current.epoch !== entry.route.epoch) throw new Error('Account changed');
  } catch { cancelComment(entry, 'account-change'); return false; }
  clearTimeout(entry.timer);
  if (commentArms.get(entry.key) === entry) commentArms.delete(entry.key);
  entry.receipt.writeAttempted = true;
  try {
    entry.res.writeHead(entry.receipt.responseStatus, { ...entry.headers, 'Access-Control-Allow-Origin': '*' });
    entry.res.end(entry.raw); entry.receipt.endReturnedAt = Date.now(); return true;
  } catch { cancelComment(entry, 'write-error'); return false; }
}
function truncateCommentResponse(entry, cause) {
  if (entry.receipt.terminalCause !== null) return;
  if (!entry.res || entry.res.destroyed || entry.res.writableEnded) { cancelComment(entry, 'peer-close-before-finish'); return; }
  try {
    const current = codexContextRouting(entry.route, { requireConversation: true });
    if (current.owner !== entry.route.owner || current.epoch !== entry.route.epoch) throw new Error('Account changed');
  } catch { cancelComment(entry, 'account-change'); return; }
  // A pre-header reset can be transparently replayed by an HTTP client. Start
  // a real response, but never deliver a complete JSON receipt or call end().
  // These are server-write observations, not proof of a browser callback.
  const fault = entry.receipt.responseFault = { mode: 'partial-json',
    expectedBodyBytes: Buffer.byteLength(entry.raw), attemptedBodyBytes: 0,
    headersFlushedAt: null, writeCompletedAt: null, cutAt: null };
  const headers = Object.fromEntries(Object.entries(entry.headers || {})
    .filter(([key]) => !['content-length', 'transfer-encoding', 'connection'].includes(key.toLowerCase())));
  clearTimeout(entry.timer);
  entry.receipt.writeAttempted = true;
  entry.faultTimer = setTimeout(() => cancelComment(entry, 'write-error'), 250);
  try {
    entry.res.writeHead(entry.receipt.responseStatus, { ...headers, 'Access-Control-Allow-Origin': '*',
      'Content-Length': String(fault.expectedBodyBytes), Connection: 'close' });
    entry.res.flushHeaders(); fault.headersFlushedAt = Date.now();
    fault.attemptedBodyBytes = 1;
    entry.res.write('{', error => {
      if (entry.receipt.terminalCause !== null) return;
      if (error) { cancelComment(entry, 'write-error'); return; }
      fault.writeCompletedAt = Date.now();
      clearTimeout(entry.faultTimer);
      entry.faultTimer = setTimeout(() => {
        fault.cutAt = Date.now(); cancelComment(entry, cause);
      }, 25);
    });
  } catch { cancelComment(entry, 'write-error'); }
}
function clearCommentRecovery(recovery, cause) {
  clearTimeout(recovery.timer);
  if (commentRecoveryGets.get(recovery.key) === recovery) commentRecoveryGets.delete(recovery.key);
  if (cause) recovery.receipt.terminalCause ??= cause;
}
function armCommentRecovery(entry) {
  const receipt = { armedAt: Date.now(), deadlineAt: Date.now() + 30000, requestId: null, terminalCause: null };
  entry.receipt.recoveryGet = receipt;
  const recovery = { key: entry.key, receipt, parent: entry.receipt };
  commentRecoveryGets.set(entry.key, recovery);
  recovery.timer = setTimeout(() => {
    if (commentRecoveryGets.get(entry.key) === recovery) clearCommentRecovery(recovery, 'expiry');
  }, receipt.deadlineAt - Date.now()); recovery.timer.unref?.();
}
async function inspectCommentStore() {
  const briefings = [];
  for (const room of sourceChangeScene.identities) {
    const comments = (await sourceChangeScene.store.listRecords('a', 'briefing-comments', record => record.briefingId === room.briefing.id))
      .sort((a, b) => a.seq - b.seq);
    briefings.push({ briefingId: room.briefing.id, conversationId: room.conversationId, account: 'a', count: comments.length,
      truncated: false, comments: comments.map(record => ({ id: record.id, clientRequestId: record.clientRequestId,
        seq: record.seq, stepId: record.stepId, sourceIds: record.sourceIds, storedHash: commentHash(JSON.stringify(record)),
        textHash: commentHash(record.text) })) });
  }
  return { kind: 'qa-read-only-store', readAt: Date.now(), briefings };
}
async function commentControl(req, res, url) {
  if (req.method !== 'POST' || url.search || req.url !== url.pathname) contextError('INVALID_CONTEXT_ROUTING', 'Comment controls use exact POST paths without query', 400);
  if (req.headers['x-egdesk-qa-token'] !== token) return json(res, 403, { error: 'Fixture token required' });
  const body = await bodyJson(req), release = url.pathname.endsWith('/release');
  const r = commentRoute(body, release ? ['holdId', 'requestId', 'clientRequestId'] : ['clientRequestId', 'bindNextPost', 'mode', 'deadlineAt', 'recoveryGetResponseLostOnce']);
  if (!sourceChangeScene.identities.some(room => room.conversationId === r.conversationId && room.briefing.id === r.briefingId)) {
    contextError('CONTEXT_THREAD_MISMATCH', 'Control requires the Briefing of this exact seeded room', 403);
  }
  if (!release) {
    const next = body.bindNextPost === true;
    if (next ? Object.hasOwn(body, 'clientRequestId') : Object.hasOwn(body, 'bindNextPost') || !commentUUID(body.clientRequestId)) {
      contextError('INVALID_COMMENT_CONTROL', 'Choose one exact clientRequestId or bindNextPost:true', 400);
    }
    if (!['hold', 'committed-response-lost'].includes(body.mode) || (body.mode === 'hold'
      ? !Number.isSafeInteger(body.deadlineAt) || body.deadlineAt <= Date.now() || body.deadlineAt > Date.now() + 30000
      : Object.hasOwn(body, 'deadlineAt'))) contextError('INVALID_COMMENT_CONTROL', 'Hold needs a deadline within 30 seconds; lost accepts none', 400);
    if (Object.hasOwn(body, 'recoveryGetResponseLostOnce') && (body.mode !== 'committed-response-lost'
      || typeof body.recoveryGetResponseLostOnce !== 'boolean')) contextError('INVALID_COMMENT_CONTROL', 'Recovery GET response loss is boolean and only valid after committed-response-lost', 400);
    if (commentArms.has(commentKey(r)) || commentRecoveryGets.has(commentKey(r))) contextError('QA_COMMENT_ALREADY_ARMED', 'One response arm per exact Briefing scope');
    if (commentArms.size + commentRecoveryGets.size >= 32) contextError('QA_COMMENT_ARM_LIMIT', 'At most 32 scoped response arms', 429);
    const entry = newCommentEntry(r, { holdId: randomUUID(), clientRequestId: body.clientRequestId || null,
      bindNextPost: next, mode: body.mode, deadlineAt: body.deadlineAt || Date.now() + 30000,
      recoveryGetResponseLostOnce: body.recoveryGetResponseLostOnce === true });
    commentArms.set(entry.key, entry);
    entry.timer = setTimeout(() => {
      if (commentArms.get(entry.key) === entry && entry.receipt.terminalCause === null) cancelComment(entry, 'expiry');
    }, entry.deadlineAt - Date.now()); entry.timer.unref?.();
    return json(res, 200, { ok: true, fixtureOnly: true, holdId: entry.holdId, clientRequestId: entry.receipt.clientRequestId, requestId: null });
  }
  if (![body.holdId, body.requestId, body.clientRequestId].every(commentUUID)) contextError('INVALID_COMMENT_CONTROL', 'Release needs exact holdId, received requestId and clientRequestId', 400);
  const receipt = commentReceipts.find(row => row.requestId === body.requestId);
  if (!receipt) contextError('QA_COMMENT_RESPONSE_NOT_FOUND', 'No retained receipt for this request');
  if (receipt.account !== r.owner || receipt.epoch !== r.epoch) contextError('ACCOUNT_CHANGED', 'Original comment account epoch changed', 403);
  if (receipt.holdId !== body.holdId || receipt.clientRequestId !== body.clientRequestId || commentKeys.some(key => receipt.R[key] !== r[key])) contextError('QA_COMMENT_SCOPE_MISMATCH', 'Release does not match the original scoped request');
  receipt.releaseAttemptAt = Date.now(); receipt.releaseAttempts++;
  if (receipt.terminalCause || receipt.writeAttempted) return json(res, 409, { code: receipt.terminalCause === 'finished' ? 'QA_COMMENT_ALREADY_RELEASED' : 'QA_COMMENT_ALREADY_CLOSED', receipt });
  const entry = commentArms.get(commentKey(r));
  if (!entry || entry.receipt !== receipt || !entry.raw || receipt.committedAt === null) contextError('QA_COMMENT_NOT_COMMITTED', 'Original held response has not completed storage');
  if (Date.now() >= entry.deadlineAt) cancelComment(entry, 'expiry');
  const written = writeComment(entry);
  return json(res, written ? 200 : 409, { ok: written, fixtureOnly: true, receipt });
}
async function handleCommentRequest(req, res, url, briefingId) {
  const hints = exactContextQuery(url), r = commentRoute({ ...hints, briefingId });
  if (!guardBridgeRequest(req, PORT)) return json(res, 403, { code: 'CONTEXT_LOOPBACK_REQUIRED', error: 'Trusted loopback origin required' });
  if (req.method === 'OPTIONS') return json(res, 204, {});
  if (!['GET', 'POST'].includes(req.method)) return json(res, 405, { code: 'METHOD_NOT_ALLOWED' });
  let parsed, rawRequest = Buffer.alloc(0);
  if (req.method === 'POST') {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += value.length;
      if (bytes > 16 * 1024) contextError('BODY_TOO_LARGE', 'Comment body exceeds 16384 bytes', 413);
      chunks.push(value);
    }
    rawRequest = Buffer.concat(chunks);
    try { parsed = JSON.parse(rawRequest.toString('utf8')); } catch {}
  }
  const arm = commentArms.get(commentKey(r));
  const claims = req.method === 'POST' && commentUUID(parsed?.clientRequestId) && arm && !arm.receipt.requestId
    && (arm.bindNextPost || arm.clientRequestId.toLowerCase() === parsed.clientRequestId.toLowerCase());
  const entry = claims ? arm : newCommentEntry(r, { method: req.method });
  if (req.method === 'POST' && commentUUID(parsed?.clientRequestId)) entry.receipt.clientRequestId = parsed.clientRequestId;
  receiveComment(entry, res);
  // Buffering precedes the real handler, so preserve the authority captured
  // before body receipt. A→B→A must not become a fresh-authority save.
  if (!authLoggedIn || accountVariant !== r.owner || codexContextEpoch !== r.epoch) {
    const rejected = { code: 'ACCOUNT_CHANGED', error: 'Briefing comment account changed while receiving the request body' };
    Object.assign(entry.receipt, { responseStatus: 403, responseHash: commentHash(JSON.stringify(rejected)),
      terminalCause: 'account-change', writeAttempted: true });
    json(res, 403, rejected); entry.receipt.endReturnedAt = Date.now();
    return;
  }
  const recovery = req.method === 'GET' ? commentRecoveryGets.get(entry.key) : null;
  if (recovery) {
    clearCommentRecovery(recovery, Date.now() >= recovery.receipt.deadlineAt ? 'expiry' : null);
    if (recovery.receipt.terminalCause === null) {
      entry.recovery = recovery;
      recovery.receipt.requestId = entry.receipt.requestId;
      entry.receipt.recoveryOf = { holdId: recovery.parent.holdId, requestId: recovery.parent.requestId,
        clientRequestId: recovery.parent.clientRequestId };
    }
  }
  const replay = Object.assign(Readable.from(rawRequest.length ? [rawRequest] : []), { method: req.method, url: req.url, headers: req.headers, socket: req.socket });
  const sink = { writeHead(status, headers) { entry.receipt.responseStatus = status; entry.headers = headers; },
    end(value) { entry.raw = String(value); entry.receipt.responseHash = commentHash(entry.raw); } };
  await briefingCommentsHandler(replay, sink, url);
  const value = JSON.parse(entry.raw);
  if (req.method === 'POST' && entry.receipt.responseStatus === 201) {
    // This receipt is stamped only AFTER the real HTTP/runtime save has
    // returned and its actual Context record is read back. Never fake a save.
    const stored = await sourceChangeScene.store.getRecord(r.owner, 'briefing-comments', value.comment.id);
    if (stored.briefingId !== briefingId || stored.conversationId !== r.conversationId || stored.seq !== value.comment.seq
      || stored.clientRequestId.toLowerCase() !== parsed.clientRequestId.toLowerCase()) throw new Error('Comment store read-back mismatch');
    Object.assign(entry.receipt, { committedAt: Date.now(), commentId: stored.id, seq: stored.seq, storedHash: commentHash(JSON.stringify(stored)) });
  } else if (req.method === 'GET' && entry.receipt.responseStatus === 200) {
    entry.receipt.readCompletedAt = Date.now();
    entry.receipt.listed = value.comments.map(({ id, clientRequestId, seq }) => ({ id, clientRequestId, seq }));
  }
  if (entry.receipt.terminalCause) return;
  if (entry.recovery) { truncateCommentResponse(entry, 'recovery-get-response-lost'); return; }
  if (claims && entry.receipt.committedAt !== null) {
    if (entry.mode === 'committed-response-lost') {
      if (entry.recoveryGetResponseLostOnce) armCommentRecovery(entry);
      truncateCommentResponse(entry, 'committed-response-lost');
    }
    // A held response retains the original body across a UI room switch.
    return;
  }
  writeComment(entry);
}
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
  if (firstCodexAuthFixture) return { isLoggedIn: authLoggedIn, loginInProgress: !!authLoginId,
    statusText: authLoggedIn ? 'Synthetic QA account' : authLoginId ? 'Synthetic QA login pending' : 'Synthetic QA login required',
    requiresOpenaiAuth: !authLoggedIn, accountId: authLoggedIn ? 'chatgpt' : null,
    authMode: authLoggedIn ? 'chatgpt' : null, accountEmail: authLoggedIn ? 'qa-first-codex@egdesk.invalid' : null,
    authSessionId: authLoginId };
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
    run.briefing = { id: randomUUID(), title: 'QA captured-input briefing',
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
  const seeded = sourceChangeScene?.snapshot(conversationId);
  if (seeded) {
    if (!authLoggedIn || accountVariant !== 'a') contextError('ACCOUNT_CHANGED', 'Seed conversation belongs to its original synthetic account', 403);
    return { ...seeded, streamId, seq };
  }
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
    if (memoCase && memoUnavailable()) return;
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
    if (briefingMultiTargetEnabled && req.method === 'POST') {
      if (url.pathname === '/chat/send') briefingMultiTargetAttempts.sendPosts++;
      else if (url.pathname === '/context/captures') briefingMultiTargetAttempts.capturePosts++;
      else if (url.pathname.startsWith('/context/briefings') || url.pathname.startsWith('/context/briefing-comments')) briefingMultiTargetAttempts.commentPosts++;
    }
    // Count at route entry, before origin, auth, body or scenario validation.
    // No body or credential data is captured by this counter.
    if (firstCodexAuthFixture && req.method === 'POST' && url.pathname === '/chat/send') {
      const attempts = observed.chatSendPostAttempts;
      attempts.total++;
      attempts[authLoggedIn ? 'signedIn' : 'signedOut']++;
    }
    if (url.origin !== origin || url.username || url.password
        || (req.headers.host && req.headers.host !== `${HOST}:${PORT}`)
        || (req.socket?.remoteAddress && !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress))) {
      return json(res, 400, { error: 'Fixture accepts only its loopback origin' });
    }
    if (dayOne && await dayOne.handle(req, res, url)) return;
    if (memoCase) {
      if (!guardBridgeRequest(req, PORT)) return json(res, 403, { error: 'Memo fixture requires a trusted loopback initiator' });
      if (memoClosed) return json(res, 503, { error: 'Memo fixture is closed' });
      const paths = ['/health', '/v1/state', '/auth/status', '/events', '/chat/state', '/chat/resume', '/chat/send',
        '/chat/interrupt', '/v1/files/projects/room-default', '/__qa/state', '/__qa/release'];
      if (!paths.includes(url.pathname)) return json(res, 403, { error: 'Memo fixture has no fallback route' });
      if (['/chat/send', '/__qa/release'].includes(url.pathname)) {
        if (url.search) return json(res, 400, { error: 'Memo fixture writes require an exact path' });
        const status = memoUnavailable();
        if (status) return json(res, status, { error: 'Memo fixture lease expired' });
      }
    }
    if (sourceStatusEnabled && sourceChangeClosing) return json(res, 503, { code: 'QA_FIXTURE_CLOSED', error: 'Source-status fixture is closed' });
    if (sourceChangeReady) {
      if (sourceChangeClosing) return json(res, 503, { code: 'QA_FIXTURE_CLOSED', error: 'Source-change fixture is closed' });
      await sourceChangeReady;
      if (req.method === 'POST' && ['/context/captures', '/chat/send'].includes(url.pathname)) {
        return json(res, 403, { code: briefingCommentsSeedEnabled ? 'QA_BRIEFING_COMMENTS_READ_ONLY' : 'QA_SOURCE_CHANGE_READ_ONLY', error: 'Seed scene only inspects existing inputs; no runtime capture or send' });
      }
      if (url.pathname === '/chat/history' || url.pathname.startsWith('/chat/history/')) {
        if (!authLoggedIn || accountVariant !== 'a') return json(res, 403, { code: 'ACCOUNT_CHANGED', error: 'Seed history belongs to its original synthetic account' });
        const allowed = url.pathname === '/chat/history' ? ['clientThreadId', 'afterSeq', 'limit']
          : url.pathname === '/chat/history/threads' ? ['cursor', 'limit'] : null;
        if (!allowed || !['GET', 'OPTIONS'].includes(req.method)) return json(res, 405, { code: 'METHOD_NOT_ALLOWED', error: 'Seed history is read-only' });
        if ([...url.searchParams.keys()].some(k => !allowed.includes(k) || url.searchParams.getAll(k).length !== 1)) return json(res, 400, { code: 'INVALID_HISTORY_QUERY' });
        if (req.method === 'OPTIONS') return json(res, 204, {});
        if (await sourceChangeHistoryHandler(req, res, url)) return;
      }
    }
    if (briefingCommentsSeedEnabled) {
      if (['/__qa/briefing-comments/config', '/__qa/briefing-comments/release'].includes(url.pathname)) {
        if (!guardBridgeRequest(req, PORT)) return json(res, 403, { code: 'CONTEXT_LOOPBACK_REQUIRED' });
        return await commentControl(req, res, url);
      }
      const comments = url.pathname.match(/^\/context\/briefings\/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\/comments$/i);
      if (comments && req.url.split('?')[0] === url.pathname) return await handleCommentRequest(req, res, url, comments[1]);
      if (url.pathname.startsWith('/context/briefings') || url.pathname.startsWith('/context/briefing-comments')) {
        return json(res, 404, { code: 'QA_COMMENT_ROUTE_REFUSED', error: 'Only exact seeded Briefing comments GET/POST are exposed' });
      }
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
      if (sourceStatusEnabled && url.pathname === '/context/sources') exactContextQuery(url);
      const paths = ['/health', '/v1/state', '/auth/status', '/events', '/chat/state', '/chat/resume',
        '/chat/send', '/chat/interrupt', '/chat/approval', '/chat/user-input', '/__qa/state', '/__qa/release',
        ...(firstCodexAuthFixture ? ['/auth/start', '/auth/cancel', '/__qa/auth-result'] : []),
        '/__qa/auth-refresh', '/__qa/reconnect', '/__qa/replay', '/auth/signout', '/__qa/hold-resume',
        '/__qa/release-resume', '/__qa/history', '/__qa/delta', '/__qa/auth-diagnostics', '/__qa/runtime-ready',
        '/__qa/account-change', '/__qa/terminal-mode', '/terminal/spawn', '/terminal/read', '/terminal/kill', '/terminal/resize',
        '/context/captures', ...(sourceStatusEnabled ? ['/context/sources'] : []), ...(claudeFixture ? ['/context/capabilities'] : []), '/__qa/context-config', '/__qa/context-release', '/__qa/hold-stop', '/__qa/release-stop'];
      return json(res, paths.includes(url.pathname) || /^\/context\/captures\/[\da-f-]{36}$/i.test(url.pathname) ? 204 : 404, {});
    }
    if (req.method === 'GET' && url.pathname === '/__qa/state') {
      if (req.headers['x-egdesk-qa-token'] !== token) return json(res, 403, { error: 'Fixture token required' });
      if (dayOne) {
        const d = dayOne.snapshot();
        return json(res, 200, { fixture: true, profile, artifactRoot, clients: clients.size, streamId: d.streamId, runs: d.runs,
          observed: { sends: d.sends }, context: { captureBatches: d.captureBatches, deliveries: d.runs.flatMap(run => run.contextPackets.map(packet => ({ sourceId: packet.sourceId, packet }))) }, dayOne: d });
      }
      return json(res, 200, { fixture: true, profile, host: HOST, port: PORT, origin, artifactRoot, artifactPath,
        ...(memoCase ? { memoRoundTrip: memoEvidence() } : {}),
        ...(firstCodexAuthFixture ? { firstCodexAuthFixture: true, firstCodexAuthBoundary } : {}),
        ...(projectFileFixture ? { projectFileFixture: true, providerTurns: 0,
          nativePickerInvocations: 0, nativeProcessSpawns: 0 } : {}),
        ...(claudeFixture ? { claudeFixture: true, claudeReaderFixture, providerTurns: 0 } : {}),
        ...(runOutputsFixture ? { runOutputsFixture: true, providerTurns: 0, runOutputs: runOutputsFixture.stats() } : {}),
        ...(portableTransferFixture ? { portableTransferFixture: true, providerTurns: 0,
          nativePickerInvocations: 0, nativeProcessSpawns: 0, portableTransfer: portableTransferFixture.snapshot() } : {}),
        ...(taskGateFixture ? { taskGateFixture: true, providerTurns: 0, nativeProcessSpawns: 0, taskGate: taskGateFixture.snapshot() } : {}),
        ...(originFileFixture ? { chatOriginFileFixture: true, providerTurns: 0, nativeProcessSpawns: 0, chatOriginFile: originFileFixture.snapshot() } : {}),
        streamId, seq, clients: clients.size, observed, context: context.stats, pendingContextCaptures: heldCaptures.length,
        ...(sourceStatusEnabled ? { sourceStatus: { ...sourceStatusEvidence,
          receipts: sourceReceipts.filter(receipt => receipt.kind !== 'capture-get'),
          responses: [...sourceResponses.values()].filter(entry => entry.kind !== 'capture-get').map(({ route, mode, deadlineAt, res, receipt }) => ({ ...route, mode, deadlineAt,
            holdId: receipt?.holdId || null, requestId: receipt?.requestId || null, phase: res ? 'pending' : 'armed' })) },
          captureGet: { ...captureGetEvidence, receipts: sourceReceipts.filter(receipt => receipt.kind === 'capture-get'),
            responses: [...sourceResponses.values()].filter(entry => entry.kind === 'capture-get').map(({ route, mode, deadlineAt, res, receipt }) =>
              ({ ...route, mode, deadlineAt, holdId: receipt?.holdId || null, requestId: receipt?.requestId || null,
                phase: !res ? 'armed' : receipt?.snapshotHash ? 'pending' : 'reading' })) },
          sourceChangeSeed: sourceChangeSeedEnabled ? sourceChangeScene?.metadata || null : null } : {}),
        ...(briefingMultiTargetEnabled ? { briefingMultiTargetAttempts } : {}),
        ...(briefingCommentsSeedEnabled ? { briefingCommentsSeed: sourceChangeScene.metadata,
          briefingComments: { version: 1, receiptLimit: 64,
            armed: [...commentArms.values()].map(entry => ({ holdId: entry.holdId, R: entry.receipt.R,
              account: entry.route.owner, epoch: entry.route.epoch, mode: entry.mode, bindNextPost: entry.bindNextPost,
              clientRequestId: entry.receipt.clientRequestId, deadlineAt: entry.deadlineAt,
              ...(entry.recoveryGetResponseLostOnce ? { recoveryGetResponseLostOnce: true } : {}) })),
            receipts: commentReceipts, storeInspection: await inspectCommentStore() } } : {}),
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
      if (url.pathname === '/__qa/context-config' && (Object.hasOwn(body, 'sourceStatus') || Object.hasOwn(body, 'sourceStatusResponse')
          || Object.hasOwn(body, 'captureGetResponse'))) {
        if (url.search) contextError('INVALID_CONTEXT_ROUTING', 'Source controls accept no query', 400);
        if (Object.keys(body).length !== 1) contextError('INVALID_CONTEXT_ROUTING', 'Source controls must be isolated from capture controls', 400);
        if (body.sourceStatus) {
          const value = body.sourceStatus, r = sourceControl(value, ['state', 'reason', 'changedAt']);
          if (!['active', 'stale', 'missing'].includes(value.state)
            || (value.state === 'stale' ? !['fileChanged', 'navigated', 'unknown'].includes(value.reason)
              || !Number.isSafeInteger(value.changedAt) || value.changedAt < 0
              : value.reason !== null || value.changedAt !== null)) contextError('INVALID_SOURCE_STATUS', 'Exact state, reason and epoch-millisecond time required', 400);
          if (sourceStatusEvidence.controls.length >= 512) contextError('QA_TRACE_LIMIT', 'Bounded source-status trace is full', 429);
          context.setSourceStatus({ ...r, state: value.state, reason: value.reason, changedAt: value.changedAt });
          sourceTrace('controls', { ...r, state: value.state, reason: value.reason, changedAt: value.changedAt });
        } else if (Object.hasOwn(body, 'captureGetResponse')) {
          const value = body.captureGetResponse, origin = sourceControl(value, ['startLine', 'endLine', 'mode', 'deadlineAt']);
          const source = context.assertSourceScope(origin);
          if (!Number.isSafeInteger(value.startLine) || !Number.isSafeInteger(value.endLine) || value.startLine < 1
              || value.endLine < value.startLine || value.endLine - value.startLine >= 500
              || !Number.isSafeInteger(source.manifest.shape?.lineCount) || value.endLine > source.manifest.shape.lineCount
              || !['hold', 'error', 'deny'].includes(value.mode) || !Number.isSafeInteger(value.deadlineAt)
              || value.deadlineAt <= Date.now() || value.deadlineAt > Date.now() + 30000) {
            contextError('INVALID_CAPTURE_GET_RESPONSE', 'Exact bounded range, mode and deadline within 30 seconds required', 400);
          }
          const r = { ...origin, startLine: value.startLine, endLine: value.endLine }, key = captureResponseKey(r);
          if (sourceResponses.has(key)) contextError('QA_CAPTURE_GET_PENDING', 'A response is already armed for this exact capture range');
          if (sourceResponseCount(true) >= 32) contextError('QA_SOURCE_RESPONSE_LIMIT', 'Too many pending capture responses', 429);
          const entry = { kind: 'capture-get', key, route: r, mode: value.mode, deadlineAt: value.deadlineAt };
          entry.receipt = createSourceReceipt(entry); sourceResponses.set(key, entry);
          entry.timer = setTimeout(() => expireSourceResponse(entry), entry.deadlineAt - Date.now()); entry.timer.unref?.();
          return json(res, 200, { ok: true, fixtureOnly: true, holdId: entry.receipt.holdId, requestId: null });
        } else {
          const value = body.sourceStatusResponse, r = sourceControl(value, ['mode', 'deadlineAt']);
          if (!['error', 'hold'].includes(value.mode) || (value.mode === 'hold'
            ? !Number.isSafeInteger(value.deadlineAt) || value.deadlineAt <= Date.now() || value.deadlineAt > Date.now() + 30000
            : Object.hasOwn(value, 'deadlineAt'))) contextError('INVALID_SOURCE_RESPONSE', 'Hold needs a deadline within 30 seconds; error accepts none', 400);
          if ([...sourceResponses.values()].some(entry => entry.kind !== 'capture-get' && sameSourceConversation(entry.route, r))) contextError('QA_SOURCE_RESPONSE_PENDING', 'One response control per exact conversation at a time');
          if (sourceResponseCount(false) >= 32) contextError('QA_SOURCE_RESPONSE_LIMIT', 'Too many pending source responses', 429);
          const key = sourceResponseKey(r), entry = { key, route: r, mode: value.mode, deadlineAt: value.deadlineAt ?? null };
          if (entry.mode === 'hold') entry.receipt = createSourceReceipt(entry);
          sourceResponses.set(key, entry);
          if (entry.mode === 'hold') {
            entry.timer = setTimeout(() => expireSourceResponse(entry), entry.deadlineAt - Date.now());
            entry.timer.unref?.();
          }
          return json(res, 200, { ok: true, fixtureOnly: true,
            ...(entry.receipt ? { holdId: entry.receipt.holdId, requestId: null } : {}) });
        }
        return json(res, 200, { ok: true, fixtureOnly: true });
      }
      if (url.pathname === '/__qa/context-release' && ['sources', 'capture-get'].includes(body.phase)) {
        if (url.search) contextError('INVALID_CONTEXT_ROUTING', 'Source release accepts no query', 400);
        const captureGet = body.phase === 'capture-get';
        const origin = sourceControl(body, ['phase', 'requestId', ...(captureGet ? ['startLine', 'endLine'] : [])]);
        if (captureGet && (!Number.isSafeInteger(body.startLine) || !Number.isSafeInteger(body.endLine)
            || body.startLine < 1 || body.endLine < body.startLine || body.endLine - body.startLine >= 500)) {
          contextError('INVALID_CONTEXT_ROUTING', 'Exact bounded capture range required', 400);
        }
        const r = captureGet ? { ...origin, startLine: body.startLine, endLine: body.endLine } : origin;
        if (typeof body.requestId !== 'string' || !/^[\da-f-]{36}$/i.test(body.requestId)) contextError('INVALID_SOURCE_REQUEST_ID', 'Exact received GET requestId required', 400);
        const receipt = sourceReceipts.find(row => row.requestId === body.requestId);
        if (!receipt) contextError('QA_SOURCE_RESPONSE_NOT_FOUND', 'No retained receipt for this received GET');
        if (receipt.account !== r.owner || receipt.epoch !== r.epoch) contextError('ACCOUNT_CHANGED', 'Received GET belongs to another account epoch', 403);
        if ((receipt.kind === 'capture-get') !== captureGet || [...contextRoutingKeys, 'sourceId', ...(captureGet ? ['startLine', 'endLine'] : [])]
          .some(key => receipt.R[key] !== r[key])) contextError('QA_SOURCE_RESPONSE_SCOPE_MISMATCH', 'requestId belongs to another exact source route');
        if (captureGet) {
          if (captureGetEvidence.releases.length >= 512) contextError('QA_TRACE_LIMIT', 'Bounded capture-release trace is full', 429);
          captureGetEvidence.releases.push({ ...r, requestId: body.requestId });
        } else sourceTrace('releases', { ...r, requestId: body.requestId });
        receipt.releaseAttemptAt = Date.now(); receipt.releaseAttempts++;
        if (receipt.terminalCause !== null || receipt.writeAttempted) {
          return json(res, 409, { ok: false, code: receipt.terminalCause === 'finished' || receipt.writeAttempted && !receipt.terminalCause
            ? 'QA_SOURCE_RESPONSE_ALREADY_RELEASED' : 'QA_SOURCE_RESPONSE_ALREADY_CLOSED', receipt: structuredClone(receipt) });
        }
        const key = captureGet ? captureResponseKey(r) : sourceResponseKey(r), entry = sourceResponses.get(key);
        if (!entry?.res || entry.receipt !== receipt) contextError('QA_SOURCE_RESPONSE_NOT_HELD', 'Exact original GET is no longer held');
        if (captureGet && entry.snapshot === undefined) contextError('QA_SOURCE_RESPONSE_NOT_HELD', 'Exact capture snapshot is not yet held');
        if (entry.deadlineAt <= Date.now()) {
          expireSourceResponse(entry);
          return json(res, 409, { ok: false, code: 'QA_SOURCE_RESPONSE_ALREADY_CLOSED', receipt: structuredClone(receipt) });
        }
        // Deliver the original snapshot even when the UI has moved elsewhere.
        // Only account epoch changes invalidate server authority, never UI state.
        const written = finishSourceResponse(entry, 200, entry.snapshot);
        return json(res, written ? 200 : 409, { ok: written, fixtureOnly: true,
          ...(written ? {} : { code: 'QA_SOURCE_RESPONSE_ALREADY_CLOSED' }), receipt: structuredClone(receipt) });
      }
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
    if (sourceStatusEnabled && url.pathname === '/context/sources') {
      const query = exactContextQuery(url);
      const r = codexContextRouting(query, { requireConversation: true });
      if (req.method !== 'GET') return json(res, 405, { code: 'METHOD_NOT_ALLOWED', error: 'Use GET for source status' });
      const snapshot = context.sourceStatus(r);
      sourceTrace('reads', { ...r, response: structuredClone(snapshot) });
      const pending = [...sourceResponses.entries()].find(([, entry]) => entry.kind !== 'capture-get' && sameSourceConversation(entry.route, r) && !entry.res);
      if (pending) {
        const [key, entry] = pending;
        if (entry.mode === 'error') { sourceResponses.delete(key); return json(res, 503, { code: 'QA_SOURCE_STATUS_FAILED', error: 'Explicit source status failure' }); }
        receiveSourceResponse(entry, res, snapshot);
        if (entry.deadlineAt <= Date.now()) {
          expireSourceResponse(entry);
        }
        return;
      }
      return json(res, 200, snapshot);
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
      const query = exactContextQuery(url, ['startLine', 'endLine', 'packetId']);
      const authority = claudeFixture ? claudeContextRouting(query)
        : contextRoutingKeys.some(key => url.searchParams.has(key)) ? codexContextRouting(query) : null;
      const options = Object.fromEntries(['startLine', 'endLine'].filter(key => url.searchParams.has(key)).map(key => [key, Number(url.searchParams.get(key))]));
      if (url.searchParams.has('packetId')) options.packetId = url.searchParams.get('packetId');
      const r = sourceStatusEnabled && authority && !options.packetId && Number.isSafeInteger(options.startLine) && Number.isSafeInteger(options.endLine)
        ? { ...authority, sourceId: captureRoute[1], startLine: options.startLine, endLine: options.endLine } : null;
      const pending = r && sourceResponses.get(captureResponseKey(r));
      // Claim synchronously before the store read yields. A second matching
      // GET must not overtake the first and steal its one-shot arm.
      const entry = pending && !pending.claimed ? pending : null;
      if (entry) {
        entry.claimed = true;
        // Own the response before awaiting the store. Expiry, disconnect,
        // account change and disposal must terminate even a stalled read.
        receiveSourceResponse(entry, res);
        if (res.destroyed || res.writableEnded) {
          entry.receipt.terminalCause ??= 'peer-close-before-finish'; entry.receipt.closeAt ??= Date.now();
          entry.receipt.writableFinishedAtClose = res.writableFinished === true;
          sourceResponsesInFlight.delete(entry); forgetSourceResponse(entry); return;
        }
      }
      let snapshot;
      try {
        snapshot = await context.inspect(captureRoute[1], options, authority?.owner || accountVariant, authority?.clientThreadId, authority?.conversationId);
      } catch (error) {
        if (entry) {
          if (entry.receipt.terminalCause === null) finishSourceResponse(entry, error.httpStatus || 400,
            { error: error.message, ...(error.code ? { code: error.code } : {}) }, 'capture-read-error');
          return;
        }
        throw error;
      }
      if (!entry) return json(res, 200, snapshot);
      // Account changes/expiry may occur while the immutable store read awaits.
      // Never deliver that old snapshot under a newer or expired authority.
      if (entry.receipt.terminalCause !== null || res.destroyed || res.writableEnded) return;
      if (sourceResponses.get(entry.key) !== entry || entry.route.epoch !== codexContextEpoch || entry.route.owner !== accountVariant) {
        finishSourceResponse(entry, 403, { code: 'ACCOUNT_CHANGED', error: 'Fixture capture control is no longer current' }, 'account-change');
        return;
      }
      if (entry.deadlineAt <= Date.now()) { expireSourceResponse(entry); return; }
      recordSourceResponseSnapshot(entry, snapshot);
      if (entry.mode === 'hold') return;
      const denied = entry.mode === 'deny';
      finishSourceResponse(entry, denied ? 403 : 503, { code: denied ? 'QA_CAPTURE_GET_DENIED' : 'QA_CAPTURE_GET_FAILED',
        error: denied ? 'Explicit fixture capture permission denial' : 'Explicit fixture capture failure' }, denied ? 'fixture-deny' : 'fixture-error');
      return;
    }
    if (req.method === 'POST' && url.pathname === '/__qa/release') {
      if (req.headers['x-egdesk-qa-token'] !== token) return json(res, 403, { error: 'Fixture token required' });
      const body = await bodyJson(req);
      const run = runs.get(body.runId);
      if (!run) return json(res, 404, { error: 'Unknown fixture run' });
      if (memoCase) {
        const status = memoUnavailable();
        if (status) return json(res, status, { error: 'Memo fixture lease expired or closed' });
        if (run.runId !== memoRunId || !['message', 'run'].includes(body.phase) || !isDeepStrictEqual(body, {
          sessionId: memoCase.sessionId, caseId: memoCase.caseId, memoId: memoCase.memoId,
          requestId: run.requestId, runId: run.runId, phase: body.phase,
        })) return json(res, 403, { error: 'Memo release requires the exact accepted session, case, memo and request' });
      }
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
          codexContextEpoch++;
          for (const recovery of commentRecoveryGets.values()) clearCommentRecovery(recovery, 'account-change');
          for (const entry of new Set([...commentArms.values(), ...commentPending])) cancelComment(entry, 'account-change');
          for (const entry of new Set([...sourceResponses.values(), ...sourceResponsesInFlight])) finishSourceResponse(entry, 403,
            { code: 'ACCOUNT_CHANGED', error: 'Fixture account epoch changed' }, 'account-change');
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
    if (firstCodexAuthFixture && req.method === 'POST' && url.pathname === '/auth/start') {
      const body = await bodyJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).some(key => key !== 'mode') || (body.mode != null && body.mode !== 'browser')) {
        return json(res, 400, { started: false, code: 'INVALID_QA_AUTH_MODE', message: 'Only synthetic browser login is supported' });
      }
      if (authLoggedIn) return json(res, 200, { started: false, alreadyLoggedIn: true });
      if (authLoginId) return json(res, 200, { started: false, loginInProgress: true, loginId: authLoginId, mode: 'browser' });
      authLoginId = `qa-auth-${randomUUID()}`;
      observed.authWrites.push({ route: '/auth/start', at: Date.now() });
      broadcastFixtureEvent({ type: 'auth.status', v: 1, provider: 'codex', status: authSnapshot() });
      return json(res, 200, { started: true, mode: 'browser', loginId: authLoginId, authUrl: null });
    }
    if (firstCodexAuthFixture && req.method === 'POST' && url.pathname === '/auth/cancel') {
      if (!authLoginId) return json(res, 200, { status: 'notFound' });
      authLoginId = null;
      observed.authWrites.push({ route: '/auth/cancel', at: Date.now() });
      broadcastFixtureEvent({ type: 'auth.status', v: 1, provider: 'codex', status: authSnapshot() });
      return json(res, 200, { status: 'cancelled' });
    }
    if (firstCodexAuthFixture && req.method === 'POST' && url.pathname === '/__qa/auth-result') {
      if (req.headers['x-egdesk-qa-token'] !== token) return json(res, 403, { error: 'Fixture token required' });
      const body = await bodyJson(req);
      if (!body || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).length !== 2 || !['success', 'cancel'].includes(body.outcome)
          || typeof body.loginId !== 'string') {
        return json(res, 400, { code: 'INVALID_QA_AUTH_RESULT', error: 'Exact synthetic auth result required' });
      }
      if (!authLoginId || body.loginId !== authLoginId) return json(res, 409, { code: 'STALE_QA_AUTH_SESSION', error: 'No matching pending synthetic login' });
      authLoginId = null;
      authLoggedIn = body.outcome === 'success';
      observed.authResults.push({ outcome: body.outcome, at: Date.now() });
      broadcastFixtureEvent({ type: 'auth.status', v: 1, provider: 'codex', status: authSnapshot() });
      return json(res, 200, { ok: true, status: authSnapshot() });
    }
    if (req.method === 'POST' && url.pathname === '/auth/signout') {
      // Explicit fixture implementation only. There is no real bridge/client to
      // forward to, and this module never imports a Codex runtime or credentials.
      authLoggedIn = false;
      if (firstCodexAuthFixture) authLoginId = null;
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
      if (memoCase && (body.clientThreadId !== memoExpectedSend.clientThreadId
          || !memoRunId || body.conversationId !== runs.get(memoRunId)?.conversationId)) {
        return json(res, 403, { error: 'Memo resume requires its accepted thread and conversation' });
      }
      let sourceChangeResume;
      if (sourceChangeScene) {
        const seed = sourceChangeScene.identities.find(row => row.conversationId === body.conversationId);
        if (!seed) contextError('CONTEXT_THREAD_MISMATCH', 'Resume requires an exact seeded conversation', 403);
        // The real Chat resume API permits an omitted profile. Default only
        // this seed resume validation copy, never Context GET/control or the
        // received request. Explicit null/wrong values remain invalid.
        const engineProfileIdDefaulted = !Object.hasOwn(body, 'engineProfileId');
        const validationBody = engineProfileIdDefaulted ? { ...body, engineProfileId: seed.engineProfileId } : body;
        // Match the real durable resume boundary: a new client nonce cannot
        // inherit an old native conversation. Never repair/rebind that pair.
        // Malformed client IDs still go through the existing strict validator.
        if (bounded(validationBody.clientThreadId, 512) && validationBody.clientThreadId.trim()
          && !validationBody.clientThreadId.includes('\0') && validationBody.clientThreadId !== seed.clientThreadId) {
          contextError('NATIVE_BINDING_MISMATCH', 'Native conversation is not bound to this local chat', 409);
        }
        const authority = codexContextRouting(validationBody, { requireConversation: true });
        sourceChangeResume = { requestBody: structuredClone(body), engineProfileIdDefaulted,
          validatedRoute: Object.fromEntries(contextRoutingKeys.map(key => [key, authority[key]])) };
      }
      if (claudeFixture && (body.engineId !== 'claude' || ![...runs.values()].some(run =>
        run.engineId === 'claude' && run.conversationId === body.conversationId && run.clientThreadId === body.clientThreadId
        && (!run.fixtureOwner || run.fixtureOwner === claudeOwner())))) {
        return json(res, 409, { code: 'ENGINE_MISMATCH', error: 'Resume must preserve the owned Claude conversation and client binding' });
      }
      observed.resumes.push({ conversationId: body.conversationId, clientThreadId: body.clientThreadId || null,
        ...(claudeFixture ? { engineId: body.engineId } : {}), ...(sourceChangeResume ? { sourceChangeResume } : {}) });
      const snapshot = conversationState(body.conversationId || '');
      const authority = [...runs.values()].find(run => run.conversationId === body.conversationId)?.fixtureContextAuthority;
      if (authority) assertClaudeContextCurrent(authority);
      if (holdResume) { observed.heldResumes++; heldResumes.push({ res, snapshot, authority }); return; }
      return json(res, 200, snapshot);
    }
    if (req.method === 'POST' && url.pathname === '/chat/send') {
      if (firstCodexAuthFixture && !authLoggedIn) {
        observed.authBlockedSends++;
        return json(res, 403, { accepted: false, code: 'AUTH_REQUIRED', error: 'Synthetic fixture account is signed out' });
      }
      const body = await bodyJson(req);
      assertOrdinarySend(body);
      if (firstCodexAuthFixture && body.profileEnabled !== false) {
        return json(res, 400, { accepted: false, code: 'QA_PROFILE_DISABLED_REQUIRED', error: 'First Codex QA requires no Agent profile' });
      }
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
      let matchedScenario;
      if (memoCase) {
        const status = memoUnavailable();
        if (status) return json(res, status, { error: 'Memo fixture lease expired or closed' });
        if (!memoRuntimeArmed) return json(res, 409, { error: 'Memo runtime binding has not been explicitly armed' });
        if (memoUsed) return json(res, 409, { error: 'Memo one-shot was already consumed' });
        const { requestId, ...candidate } = body;
        if (typeof requestId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(requestId)
            || !isDeepStrictEqual(candidate, memoExpectedSend)) return json(res, 403, { error: 'Memo send differs from the exact configured request' });
        matchedScenario = 'COMPLETE';
      } else matchedScenario = body.message.match(SCENARIO)?.[1]
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
      if (memoCase) memoUsed = true;
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
      if (memoCase) memoRunId = runId;
      const observedSend = { ...body, scenario, runId, acceptedAt: Date.now() };
      observed.sends.push(observedSend);
      envelope(run, 'run.started'); // Deliberately before the POST response.
      if (['CONTEXT', 'CLAUDE_CONTEXT'].includes(scenario)) envelope(run, 'context.bound', { captures: run.contextCaptures });
      // Chat72 may refresh partial history as soon as running is observed,
      // before this deliberately delayed ACK. Its STOP message must already
      // exist, and the ACK must not restart it or discard a later delta.
      if (scenario === 'STOP') stopScenario(run);
      setTimeout(() => {
        if (memoCase && memoUnavailable()) return json(res, memoUnavailable(), { accepted: false, error: 'Memo fixture expired or closed before acknowledgement' });
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
  dayOne?.dispose();
  if (memoCase) {
    memoClosed = true;
    for (const client of clients) { try { client.end(); } catch {} }
    clients.clear();
  }
  sourceChangeClosing = true;
  for (const recovery of commentRecoveryGets.values()) clearCommentRecovery(recovery, 'server-close');
  for (const entry of new Set([...commentArms.values(), ...commentPending])) cancelComment(entry, 'server-close');
  for (const entry of new Set([...sourceResponses.values(), ...sourceResponsesInFlight])) finishSourceResponse(entry, 503,
    { code: 'QA_FIXTURE_CLOSED', error: 'Fixture disposed' }, 'server-close');
  if (sourceChangeReady) return sourceChangeReady.then(scene => scene.dispose(), () => {});
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
return { handler, dispose, ...(memoRuntimeBinding ? { memoRuntimeBinding } : {}),
  ...(taskGateReady || originFileReady || sourceChangeReady ? { ready: taskGateReady || originFileReady || sourceChangeReady } : {}), info: { kind: 'egdesk-qa-fixture-ready', host: HOST, port: PORT,
  ...(memoCase ? { memoRoundTrip: memoEvidence(), providerIntegration: 'none-configured' } : {}),
  ...(firstCodexAuthFixture ? { firstCodexAuthFixture: true, firstCodexAuthBoundary } : {}),
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
