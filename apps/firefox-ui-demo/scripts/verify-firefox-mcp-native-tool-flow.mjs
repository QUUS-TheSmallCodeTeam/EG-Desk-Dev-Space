#!/usr/bin/env node
// Lane C: real EG-Desk Chat tool-flow QA. The CLI is intentionally fail-closed
// until ordinary UI bounded-policy/nonce routing and B's public receipts are wired.
// Importing this module is pure; only an explicit CLI invocation touches runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { chatIdentity, chrome, loopbackJson, newQaThread, observeChatEvents, option, runUiFlow, selectorForId,
  sendFromComposer, waitUntil } from './egdesk-qa-ui-flow.mjs';

const BROWSER_TOOL_NAMES = Object.freeze({ observe: 'egdesk_browser_observe',
  click: 'egdesk_browser_click', fill: 'egdesk_browser_fill' });
const QA_CASES = Object.freeze(['native', 'source', 'browser', 'browser-negative']);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const required = (value, label) => { assert.ok(value, label); return value; };

export function harmlessPrintfCommand(token) {
  assert.match(token, /^[A-Za-z0-9_-]{20,80}$/, 'QA command token must be a bounded public ASCII nonce');
  return `printf '%s\\n' '${token}'`;
}

export function assertHiddenMarkerOutsideModelAdmission({ marker, message, title, path: filePath, metadata }) {
  assert.match(marker, /^[A-Za-z0-9_-]{20,80}$/, 'hidden QA marker is invalid');
  const modelFacing = JSON.stringify({ message, title, path: filePath, metadata });
  assert.ok(!modelFacing.includes(marker),
    'file-content marker leaked into the model message, title, path or admission metadata');
  return true;
}

export function nativeReadCommand(file) {
  assert.match(file, /^\/[a-zA-Z0-9_./-]+$/, 'fixture path needs shell-safe canonical characters');
  return `sed -n '1,2p' '${file}'`;
}

export function nativeZshWrappedCommand(payload) {
  assert.ok(typeof payload === 'string' && payload, 'native shell payload is required');
  return `/bin/zsh -lc ${JSON.stringify(payload)}`;
}

const exactNativeCommand = (actual, payload) => actual === payload
  || actual === nativeZshWrappedCommand(payload);

export function parseDeadlineUtc(value) {
  assert.ok(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value),
    '--deadline-utc must be an explicit ISO-8601 UTC timestamp ending in Z');
  const deadlineMs = Date.parse(value);
  assert.ok(Number.isSafeInteger(deadlineMs) && new Date(deadlineMs).toISOString()
    === (value.includes('.') ? value : value.replace(/Z$/, '.000Z')), 'invalid --deadline-utc timestamp');
  return deadlineMs;
}

export function assertBeforeDeadline(deadlineMs, now = Date.now()) {
  assert.ok(Number.isSafeInteger(deadlineMs) && Number.isFinite(now) && now < deadlineMs,
    'approved round deadline reached or unavailable; do not start or continue a provider turn');
}

export function assertTurnTimeBudget(deadlineMs, now = Date.now()) {
  assertBeforeDeadline(deadlineMs, now);
  assert.ok(now + 5 * 60 * 1000 < deadlineMs,
    'less than five minutes remain; do not start a new provider turn');
}

export function parseCases(value) {
  assert.ok(typeof value === 'string' && value, '--cases is required for real runs');
  const cases = value.split(',');
  assert.ok(cases.length > 0 && cases.every(item => QA_CASES.includes(item))
    && new Set(cases).size === cases.length,
  '--cases must be a comma-separated unique subset of native,source,browser,browser-negative');
  return cases;
}

export function assertQaExecutionMode(cases, env = process.env) {
  if (cases.includes('browser-negative')) {
    assert.deepEqual(cases, ['browser-negative'], 'Browser simulator probes must run separately from provider cases');
    assert.equal(env.EGDESK_QA_BROWSER_NEGATIVE, '1', 'explicit EGDESK_QA_BROWSER_NEGATIVE=1 is required');
    assert.equal(env.EGDESK_QA_FIXTURE_TRANSPORT, '1', 'model-free Browser probes require the explicit fixture backend');
    assert.ok(typeof env.EGDESK_QA_FIXTURE_TOKEN === 'string' && env.EGDESK_QA_FIXTURE_TOKEN.length >= 16,
      'a fixture backend token is required');
  } else {
    assert.equal(env.EGDESK_QA_REAL_TURN, '1', 'explicit real-turn gate is required');
    assert.notEqual(env.EGDESK_QA_FIXTURE_TRANSPORT, '1', 'fixture transport is forbidden for provider cases');
  }
}

export function assertNegativeFixtureBackend(profile, health, state) {
  assert.equal(health?.ok, true, 'Browser probe fixture backend is unavailable');
  assert.equal(health?.fixture, true, 'model-free probes refuse a production backend');
  assert.equal(state?.fixture, true, 'Browser probes lack authenticated fixture control evidence');
  assert.equal(state?.profile, profile, 'fixture backend belongs to another Firefox profile');
  for (const key of ['sends', 'authWrites']) {
    assert.ok(Array.isArray(state.observed?.[key]) && state.observed[key].length === 0,
      `model-free Browser probes require zero fixture ${key}`);
  }
  assert.ok(Array.isArray(state.runs) && state.runs.length === 0, 'model-free Browser probes created a Chat run');
  return { fixture: true, profile, sends: 0, authWrites: 0, runs: 0, providerTurns: 0 };
}

export function assertQaAttachMode(cases, env = process.env) {
  assertQaExecutionMode(cases, env);
  const simulator = cases.length === 1 && cases[0] === 'browser-negative';
  const headless = env.EGDESK_QA_BROWSER_NEGATIVE_HEADLESS;
  assert.ok(headless == null || headless === '0' || headless === '1', 'invalid headless diagnostic gate');
  assert.ok(headless !== '1' || simulator, 'headless diagnostics are only for model-free browser-negative');
  assert.ok(env.EGDESK_MARIONETTE_PORT === '2828'
    || (simulator && env.EGDESK_MARIONETTE_PORT === '2829'),
  'Lane C requires port 2828; only fixture-only browser-negative may attach to 2829');
  return { headlessDiagnostics: simulator && headless === '1' };
}

export async function captureBrowserNegativeScreenshot(harness, cases, env = process.env) {
  const { headlessDiagnostics } = assertQaAttachMode(cases, env);
  assert.deepEqual(cases, ['browser-negative'], 'diagnostic capture is simulator-only');
  // Profile verification remains fatal, outside the narrowly bounded capture fallback.
  await harness.assertRemoteProfile();
  let headlessEvidence = {};
  if (headlessDiagnostics) {
    const isHeadless = await chrome(harness, () => {
      const gfxInfo = Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo);
      return gfxInfo.isHeadless;
    });
    assert.equal(isHeadless, true, 'headless diagnostic gate requires actual gfxInfo.isHeadless === true');
    headlessEvidence = { gfxInfoIsHeadless: isHeadless };
  }
  try {
    return { status: 'captured', path: await harness.screenshot('browser-guards-verified'), visualPass: null,
      ...headlessEvidence };
  } catch (error) {
    const unsupported = error?.message === 'screenshot_page: Error: BiDi error: "unsupported operation"'
      || /^screenshot_page:\s*(?:Error:\s*)?(?:Protocol error \(browsingContext\.captureScreenshot\):\s*)?unsupported operation(?:\s*:|\s*$)/i.test(error?.message || '');
    if (!headlessDiagnostics || !unsupported) throw error;
    return { status: 'unsupported', visualPass: null, errorCode: 'unsupported operation',
      scope: 'headless-screenshot-only', domProbeProofIndependent: true, ...headlessEvidence };
  }
}

export function parseResumeEmptyThreadId(value, cases) {
  if (value == null) return null;
  assert.ok(typeof value === 'string' && /^thread-dm-[a-z0-9]{7}$/.test(value),
    '--resume-empty-thread-id must name one generated DM thread');
  assert.deepEqual(cases, ['source'],
    '--resume-empty-thread-id is allowed only with --cases source');
  return value;
}

export function parseResumeSourceOptions({ threadId, root, sourceId, originalHash }, cases,
  resumeEmptyThreadId = null) {
  if ([threadId, root, sourceId, originalHash].every(value => value == null)) return null;
  assert.deepEqual(cases, ['source'], '--resume-source is allowed only with --cases source');
  assert.equal(resumeEmptyThreadId, null, '--resume-source cannot also resume an empty room');
  assert.match(threadId || '', /^thread-dm-[a-z0-9]{7}$/,
    '--resume-source must name one generated DM thread');
  assert.ok(typeof root === 'string' && path.isAbsolute(root),
    '--resume-source-root must be an explicit absolute QA run directory');
  assert.match(sourceId || '', /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/,
    '--resume-source-id must be the exact captured source UUID');
  assert.match(originalHash || '', /^[a-f0-9]{64}$/,
    '--resume-source-original-sha256 must be the prior capture receipt hash');
  return { threadId, root, sourceId, originalHash };
}

export function assertResumeEmptyThreadState(observed, expectedId) {
  assert.equal(observed?.activeThreadId, expectedId, 'confirmed empty room is not active');
  assert.equal(observed?.thread?.id, expectedId, 'active room ID changed');
  assert.equal(observed?.thread?.conversationId ?? null, null, 'room already has a native conversation');
  assert.equal(observed?.thread?.localConversationId ?? null, null, 'room already has local conversation history');
  assert.equal(observed?.thread?.profileEnabled, false, 'room is not ordinary Chat');
  assert.ok([null, 'fresh'].includes(observed?.thread?.bindingState ?? null),
    'room has a retained or verified native binding state');
  assert.equal(observed?.thread?.bindingAccountKey ?? null, null, 'room has a bound native account');
  assert.equal(observed?.thread?.nativeBindingHeld, false, 'room retains a native binding');
  assert.equal(observed?.thread?.messagesCount, 0, 'room already has messages');
  assert.equal(observed?.thread?.inputSourcesCount, 0, 'room already has input sources');
  assert.equal(observed?.thread?.briefingInputsCount, 0, 'room already has briefing inputs');
  assert.equal(observed?.thread?.preparingInput, false, 'room is preparing an input');
  assert.equal(observed?.thread?.resuming, false, 'room is resuming a native conversation');
  assert.equal(observed?.thread?.sendError ?? null, null, 'room has an unresolved send error');
  assert.equal(observed?.nativeRunCount, 0, 'room already has a native run');
  assert.equal(observed?.visibleInputCount, 1, 'room has no unique visible composer input');
  assert.equal(observed?.composerVisible, true, 'rendered Chat composer is not visible');
  assert.equal(observed?.inputThreadId, expectedId, 'composer belongs to another room');
  assert.equal(observed?.inputValue, '', 'composer already contains text');
  assert.equal(observed?.draftText, '', 'room already has a saved draft');
  assert.ok(typeof observed?.wireClientThreadId === 'string' && observed.wireClientThreadId,
    'room has no client binding ID');
  return true;
}

export function assertPreparedSourceResumeEvidence({ observed, expected, stored,
  originalHash, liveText, sourceFile, prompt }) {
  assert.equal(expected?.root, path.dirname(sourceFile), 'prepared source run root changed');
  assert.equal(expected?.originalHash, originalHash, 'prior capture hash input changed');
  assert.equal(observed?.activeThreadId, expected.threadId, 'prepared source room is not active');
  assert.equal(observed?.thread?.id, expected.threadId, 'prepared source room ID changed');
  assert.equal(observed?.thread?.title, 'QA immutable source read', 'prepared source room title changed');
  assert.equal(observed?.thread?.conversationId ?? null, null, 'prepared source room has a native conversation');
  assert.equal(observed?.thread?.localConversationId ?? null, null, 'prepared source room has local history');
  assert.equal(observed?.thread?.profileEnabled, false, 'prepared source room is not ordinary Chat');
  assert.ok([null, 'fresh'].includes(observed?.thread?.bindingState ?? null),
    'prepared source room retained a native binding state');
  assert.equal(observed?.thread?.bindingAccountKey ?? null, null, 'prepared source room has a native account binding');
  assert.equal(observed?.thread?.nativeBindingHeld, false, 'prepared source room retains native authority');
  assert.equal(observed?.thread?.messagesCount, 0, 'prepared source room has messages');
  assert.equal(observed?.thread?.inputSourcesCount, 0, 'prepared source room has other input sources');
  assert.equal(observed?.thread?.briefingInputsCount, 1, 'prepared source room has not exactly one attached snapshot');
  assert.equal(observed?.thread?.preparingInput, false, 'prepared source room is still preparing input');
  assert.equal(observed?.thread?.resuming, false, 'prepared source room is resuming');
  assert.equal(observed?.thread?.sendError ?? null, null, 'prepared source room has an unresolved send error');
  assert.equal(observed?.nativeRunCount, 0, 'prepared source room already has a native run');
  assert.equal(observed?.composerVisible, true, 'prepared source composer is not uniquely visible');
  assert.equal(observed?.visibleInputCount, 1, 'prepared source room has no unique visible input');
  assert.equal(observed?.inputThreadId, expected.threadId, 'prepared source composer belongs to another room');
  assert.equal(observed?.inputValue, prompt, 'prepared source composer changed');
  assert.equal(observed?.draftText, prompt, 'prepared source draft changed');
  assert.equal(observed?.sendButtonVisible, true, 'prepared source Send button is not visible');
  assert.equal(observed?.sendButtonEnabled, true, 'prepared source Send button is disabled');
  assert.equal(observed?.sendButtonUnobscured, true, 'prepared source Send button is obscured');
  assert.ok(typeof observed?.wireClientThreadId === 'string' && observed.wireClientThreadId,
    'prepared source room has no client binding ID');
  assert.equal(observed?.thread?.cwd, path.dirname(sourceFile), 'prepared source room cwd changed');
  const reference = observed?.reference;
  assert.equal(reference?.sourceId, expected.sourceId, 'attached source ID changed');
  assert.equal(reference?.snapshotId, expected.sourceId, 'attached snapshot ID changed');
  assert.equal(reference?.hash, originalHash, 'attached source hash differs from prior receipt');
  assert.equal(reference?.sourceRef?.path, sourceFile, 'attached snapshot came from another file');
  assert.equal(reference?.localSource?.sourceRef?.path, sourceFile,
    'attached local source path changed');
  assert.equal(stored?.capture?.sourceId, expected.sourceId, 'immutable inspector source ID changed');
  assert.equal(stored?.capture?.clientThreadId, observed.wireClientThreadId,
    'immutable snapshot belongs to another Chat thread');
  assert.equal(stored?.capture?.hash, originalHash, 'immutable inspector hash differs from prior receipt');
  assert.equal(stored?.capture?.sourceRef?.path, sourceFile,
    'immutable snapshot came from another file');
  assert.equal(stored?.delivered ?? null, null, 'source has an earlier delivered model packet');
  assert.deepEqual(stored?.bindings, [], 'source was already bound to another model run');
  const originalText = stored?.source?.text;
  const originalMatch = /^Public EG-Desk source QA fixture\.\n(QA_SOURCE_ORIGINAL_[a-f0-9]{24})\n$/.exec(originalText || '');
  const liveMatch = /^Public EG-Desk changed live QA source\.\n(QA_SOURCE_LIVE_[a-f0-9]{24})\n$/.exec(liveText || '');
  assert.ok(originalMatch, 'immutable original QA fixture text is unavailable');
  assert.ok(liveMatch, 'live QA fixture does not contain the expected changed text');
  assert.equal(sha256(originalText), originalHash, 'original snapshot text does not hash to prior receipt');
  assert.notEqual(sha256(liveText), originalHash, 'live file still equals the original snapshot');
  assert.ok(!JSON.stringify({ prompt, title: observed.thread.title, reference }).includes(originalMatch[1]),
    'original source marker leaked into model-facing draft admission');
  return { reference, originalNonce: originalMatch[1], changedNonce: liveMatch[1],
    originalHash, currentHash: sha256(liveText) };
}

export function scenarioCoverage(requestedCases, completedCases) {
  assert.ok(Array.isArray(requestedCases) && Array.isArray(completedCases), 'case coverage needs explicit lists');
  const selectedCasesVerified = requestedCases.every(item => completedCases.includes(item));
  // A separately selected synthetic Browser probe is not native-model proof.
  // The stronger native-model Browser negative adapter is still unavailable,
  // so even all three positive model cases leave that explicit evidence gap.
  const missingEvidence = QA_CASES.filter(item => item !== 'browser-negative'
    && !completedCases.includes(item)).map(item => `native-model-${item}`);
  missingEvidence.push('native-model-browser-negative');
  const fullScenarioVerified = selectedCasesVerified && missingEvidence.length === 0;
  return { selectedCasesVerified, fullScenarioVerified,
    coverage: fullScenarioVerified ? 'full' : 'partial', missingEvidence };
}

export function chooseChatProxyTarget(proxies, activeCardId = null) {
  assert.ok(Array.isArray(proxies), 'Chat proxy candidates must be observed');
  const visible = proxies.filter(item => item?.visible === true && typeof item.cardId === 'string' && item.cardId);
  const active = activeCardId && visible.find(item => item.cardId === activeCardId);
  if (active) return active.cardId;
  if (visible.length === 1) return visible[0].cardId;
  assert.ok(visible.length === 0, 'multiple visible Chat proxies have no unique active target');
  return null;
}

export function assertRealTransport({ realTurn, fixtureTransport, health, auth, fixtureEndpointStatus }) {
  assert.equal(realTurn, '1', 'EGDESK_QA_REAL_TURN=1 is required');
  assert.notEqual(fixtureTransport, '1', 'fixture transport must be disabled');
  assert.equal(health?.ok, true, 'real helper health is unavailable');
  assert.equal(health?.appServerReady, true, 'native app-server is not ready');
  assertMemoryIsolationBeforeTurn(health);
  assert.notEqual(health?.fixture, true, 'fixture helper cannot prove a real turn');
  assert.equal(auth?.isLoggedIn, true, 'existing provider authentication is not ready');
  assert.notEqual(auth?.loginInProgress, true, 'authentication is changing');
  assert.equal(fixtureEndpointStatus, 404, 'fixture control endpoint is exposed');
  return true;
}

export function assertMemoryIsolationBeforeTurn(health) {
  assert.equal(health?.memoryIsolation?.feature, 'memories',
    'QA helper has no verified memories feature-isolation receipt');
  assert.equal(health?.memoryIsolation?.status, 'verified-disabled',
    'QA helper memories isolation is not verified-disabled');
  return true;
}

// A's actual public /chat/state receipt. The helper verifies native
// thread/start and the empty external MCP catalog before turn/start. The QA
// caller verifies the request was emitted by the normal Chat UI beforehand,
// then independently binds this post-start receipt to the observed run.
export function assertEffectiveReadOnly(receipt) {
  assert.equal(receipt?.mode, 'readOnlyQa', 'run has no readOnlyQa policy receipt');
  assert.equal(receipt?.status, 'native-thread-verified', 'native thread policy was not verified before turn');
  assert.equal(receipt?.sandbox, 'readOnly', 'native effective sandbox is not read-only');
  assert.equal(receipt?.approvalPolicy, 'never', 'native approval policy is not noninteractive');
  assert.equal(receipt?.networkAccess, false, 'native network access is not disabled');
  assert.equal(receipt?.externalMcpCatalog, 'empty', 'native external MCP catalog was not empty');
  assert.ok(Number.isSafeInteger(receipt?.inspectedMcpServers) && receipt.inspectedMcpServers >= 0,
    'native MCP catalog inspection count is missing');
  return true;
}

export function assertReadOnlyRunReceipt(run, events, cwd) {
  assert.equal(run.cwdPublic, cwd, 'read-only policy receipt belongs to another cwd');
  assertEffectiveReadOnly(run.executionPolicy);
  assert.ok(events.some(event => event.event === 'run.executionPolicy' && event.runId === run.runId
    && event.conversationId === run.conversationId
    && same(event.details?.executionPolicy, run.executionPolicy)),
  'native read-only policy receipt event is not bound to this run');
  return true;
}

// C compares only independently observed v2 SSE and /chat/state snapshots.
// `active` must be captured while /chat/state still says inProgress and already
// carries A's native-thread-verified policy, not reconstructed after completion.
export function assertObservedRunChain({ run, events, active }) {
  assertRunIdentity(run, events, run?.clientThreadId);
  const started = events.find(event => event.event === 'run.started' && event.runId === run.runId);
  const policy = events.find(event => event.event === 'run.executionPolicy' && event.runId === run.runId);
  const completed = events.find(event => event.event === 'run.completed' && event.runId === run.runId);
  assert.equal(started?.provider, 'codex', 'original SSE provider is not Codex');
  assert.ok(typeof started?.streamId === 'string' && started.streamId,
    'original native event stream is unavailable');
  assert.ok([started, policy, completed].every(item => item?.streamId === started.streamId
    && Number.isSafeInteger(item?.seq)), 'provider, policy and completion crossed stream epochs');
  assert.ok(started.seq < policy.seq && policy.seq < completed.seq,
    'policy receipt and completion are out of native event order');
  assert.equal(active?.snapshot?.streamId, started.streamId, 'active-run snapshot crossed stream epochs');
  assert.ok(Number.isSafeInteger(active.snapshot.seq) && active.snapshot.seq >= policy.seq
    && active.snapshot.seq < completed.seq, 'active run was not captured before completion');
  const observed = active?.run;
  assert.equal(observed?.status, 'inProgress', 'active-run receipt was not observed while in progress');
  assert.equal(observed?.conversationId, run.conversationId, 'active-run conversation differs');
  assert.equal(observed?.runId, run.runId, 'active-run ID differs');
  assert.equal(observed?.answerId, run.answerId, 'active-run answer differs');
  assert.ok(typeof run.requestId === 'string' && run.requestId,
    'native run lacks the originating UI request ID');
  assert.equal(observed?.requestId, run.requestId, 'active run belongs to another UI send');
  assert.equal(started?.requestId, run.requestId, 'SSE start belongs to another UI send');
  assert.ok(same(observed.executionPolicy, run.executionPolicy),
    'active policy differs from completed native run state');
  assert.ok(same(policy.details?.executionPolicy, run.executionPolicy),
    'policy SSE receipt differs from native run state');
  return true;
}

export function assertNativeAuthorityChain({ run, events, active, cwd }) {
  assertObservedRunChain({ run, events, active });
  assertReadOnlyRunReceipt(run, events, cwd);
  return true;
}

export function assertPendingReadOnlyNoSideEffect({ pending, beforeFiles, afterFiles,
  observedEvents, observedActivities, browserDispatchesBefore, browserDispatchesAfter }) {
  assert.equal(pending?.requestedPolicy?.mode, 'readOnlyQa', 'pending case is not a read-only QA request');
  assert.ok(['policy-pending', 'policy-rejected'].includes(pending?.status),
    'pending case is not unverified or rejected');
  assert.equal(pending?.nativePolicyReceipt, null, 'pending case already has native policy proof');
  assert.equal(pending?.activeRun, null, 'pending case exposed an active run without policy proof');
  assert.equal(pending?.turnStartAttempted, false, 'native turn/start occurred without policy proof');
  assert.ok(Array.isArray(observedEvents) && !observedEvents.some(item =>
    /^(?:run\.(?:started|completed)|activity\.|context\.read\.|message\.|approval\.|browser-tool-request)/.test(item.event || '')),
  'provider/tool activity began before policy proof');
  assert.ok(Array.isArray(observedActivities) && observedActivities.length === 0,
    'native activity appeared before policy proof');
  assert.ok(Number.isSafeInteger(browserDispatchesBefore) && browserDispatchesBefore >= 0
    && browserDispatchesAfter === browserDispatchesBefore,
  'Browser actor dispatched before policy proof');
  assertNoFixtureWrites(beforeFiles, afterFiles);
  return true;
}

export function assertRunIdentity(run, events, clientThreadId) {
  assert.equal(run?.status, 'completed', 'native run did not complete');
  assert.ok(run?.conversationId && run?.runId && !run.runId.startsWith('qa-'), 'native run identity is unavailable');
  assert.equal(run.answerId, `${run.conversationId}/${run.runId}`, 'answer identity does not bind this native run');
  assert.equal(run.clientThreadId, clientThreadId, 'native run belongs to another Chat thread');
  assert.equal(run.historyComplete, true, 'native item history is incomplete');
  assert.notEqual(run.truncated, true, 'native item history was truncated');
  const starts = events.filter(event => event.event === 'run.started');
  assert.equal(starts.length, 1, 'one UI send must produce exactly one native run');
  assert.equal(starts[0].runId, run.runId, 'SSE start is not the completed native run');
  assert.equal(starts[0].clientThreadId, clientThreadId, 'SSE start belongs to another Chat thread');
  assert.ok(events.some(event => event.event === 'run.completed' && event.runId === run.runId
    && event.details?.status === 'completed'), 'native completion event is missing');
  assert.ok(events.every(event => event.provider === 'codex' && event.type === 'chat.event' && event.v === 2),
    'non-Codex or fixture event mixed into real run');
  assert.notEqual(run.fixtureOnly, true, 'fixture run is not real native evidence');
  assert.ok(events.every(event => event.details?.fixtureOnly !== true), 'fixture event is not real native evidence');
  assert.ok(!(run.activities || []).some(item => item.kind === 'fileChange'), 'read-only native run reported file changes');
  return true;
}

export function assertNoFixtureWrites(before, after, { intentionalChangePaths = [] } = {}) {
  const changed = new Set(intentionalChangePaths);
  assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'QA fixture inventory changed');
  for (const [file, evidence] of Object.entries(before)) {
    assert.ok(after[file], `fixture disappeared: ${file}`);
    if (changed.has(file)) continue;
    assert.deepEqual(after[file], evidence, `provider changed QA fixture: ${file}`);
  }
  return true;
}

export function assertNativeFileAndCommand({ run, events, nativeFile, nonce, commandTag, readCommand,
  nativeContractFingerprint, beforeFiles, afterFiles }) {
  assertRunIdentity(run, events, run.clientThreadId);
  assertReadOnlyRunReceipt(run, events, path.dirname(nativeFile));
  assertNoFixtureWrites(beforeFiles, afterFiles);
  const allCommands = (run.activities || []).filter(item => item.kind === 'commandExecution');
  assert.equal(allCommands.length, 2, 'native QA turn used more or fewer than the two scoped commands');
  assert.ok(!(run.activities || []).some(item => ['fileChange', 'mcpToolCall', 'dynamicToolCall',
    'webSearch', 'collabAgentToolCall'].includes(item.kind)),
  'native QA turn used an unrequested tool action');
  const commands = allCommands.filter(item => item.kind === 'commandExecution'
    && item.status === 'completed' && item.detail?.exitCode === 0 && item.id);
  const read = commands.find(item => exactNativeCommand(item.detail.command, readCommand)
    && item.detail.cwd === path.dirname(nativeFile));
  const harmless = commands.find(item => item.id !== read?.id
    && exactNativeCommand(item.detail.command, harmlessPrintfCommand(commandTag))
    && item.detail.cwd === path.dirname(nativeFile));
  assert.ok(read, 'native file-read command item is missing');
  assert.ok(harmless, 'distinct harmless native command item is missing');
  const receipts = run.qaCommandReceipts;
  assert.ok(Array.isArray(receipts) && receipts.length >= 2,
    'two A public QA aggregate-output receipts are unavailable');
  const findReceipt = (item, marker, otherMarker) => receipts.find(receipt =>
    receipt.nativeItemId === item.id && receipt.nativeItemType === 'commandExecution'
    && receipt.origin === 'codex-app-server.item/completed'
    && receipt.originalProviderId === 'codex-native'
    && receipt.outputStream === 'aggregated-stdout-stderr'
    && receipt.nativeItemStatus === 'completed' && receipt.status === 'marker-witness'
    && receipt.receiptScope === 'single-native-command-item'
    && receipt.exitCode === 0 && Array.isArray(receipt.markerLines)
    && receipt.markerLines.length === 1
    && receipt.markerLines.includes(marker) && !receipt.markerLines.includes(otherMarker)
    && receipt.commandHashBasis === 'sanitized-native-item-command'
    && receipt.commandSha256 === sha256(item.detail.command)
    && Number.isSafeInteger(receipt.bridgeEpoch) && receipt.bridgeEpoch >= 0
    && receipt.contractFingerprint === nativeContractFingerprint);
  const readReceipt = findReceipt(read, nonce, commandTag);
  const commandReceipt = findReceipt(harmless, commandTag, nonce);
  assert.ok(readReceipt, 'native file-read item lacks its unexpected aggregate-output marker receipt');
  assert.ok(commandReceipt, 'harmless command lacks its distinct aggregate-output marker receipt');
  assert.equal(readReceipt.bridgeEpoch, commandReceipt.bridgeEpoch,
    'two native command receipts crossed bridge epochs');
  for (const [item, receipt] of [[read, readReceipt], [harmless, commandReceipt]]) {
    assert.ok(events.some(event => event.event === 'qa.command.receipt'
      && event.requestId === run.requestId && event.clientThreadId === run.clientThreadId
      && event.conversationId === run.conversationId && event.runId === run.runId
      && event.itemId === item.id && same(event.details, receipt)),
    'A aggregate-output marker receipt is not bound to its native SSE item');
  }
  const answer = (run.messages || []).filter(item => item.role === 'assistant').map(item => item.text || '').join('\n');
  assert.ok(answer.includes(nonce), 'answer does not contain the unprompted file-content nonce');
  assert.ok(answer.includes(commandTag), 'answer does not report the harmless command output marker');
  return { readItemId: read.id, commandItemId: harmless.id,
    commandOutput: { kind: 'aggregate-output-marker-lines', verifiedMarkers: 2 } };
}

export function assertSourceRead({ run, events, reference, originalNonce, changedNonce,
  originalHash, currentHash, stored, beforeFiles, afterFiles, changedFile }) {
  assertRunIdentity(run, events, run.clientThreadId);
  assertReadOnlyRunReceipt(run, events, path.dirname(changedFile));
  assertNoFixtureWrites(beforeFiles, afterFiles);
  assert.notEqual(originalHash, currentHash, 'live source was not intentionally changed after capture');
  assert.equal(reference?.sourceId, reference?.snapshotId, 'source/snapshot ID differs');
  assert.equal(reference?.hash, originalHash, 'capture hash is not original bytes');
  assert.equal(run.context?.captures?.length, 1, 'source run did not bind exactly one capture');
  const capture = (run.context?.captures || []).find(item => item.sourceId === reference.sourceId);
  assert.ok(capture && capture.hash === originalHash, 'run lacks the original immutable source binding');
  assert.equal(stored?.capture?.sourceId, reference.sourceId, 'inspector source ID differs');
  assert.equal(stored?.capture?.hash, originalHash, 'inspector capture hash differs');
  assert.ok(stored?.source?.text?.includes(originalNonce), 'immutable inspector lacks original nonce');
  assert.ok(!stored.source.text.includes(changedNonce), 'immutable capture became live-file contents');
  assert.ok(!(run.activities || []).some(item => item.kind === 'commandExecution'),
    'custom-source turn also used a native command; source-read evidence is not distinct');
  const allNamed = (run.activities || []).filter(item => item.kind === 'dynamicToolCall'
    && item.detail?.tool === 'egdesk_read_source');
  const named = allNamed.filter(item => item.status === 'completed');
  const packets = (run.context?.packets || []).filter(item => item.sourceId === reference.sourceId
    && item.deliveryStatus === 'sent-to-app-server');
  const allReads = events.filter(event => event.event === 'context.read.completed'
    && event.runId === run.runId);
  const reads = allReads.filter(event => event.details?.sourceId === reference.sourceId
    && event.details?.deliveryStatus === 'sent-to-app-server' && event.details?.receiptId);
  assert.equal(named.length, allNamed.length, 'source run has an incomplete egdesk_read_source item');
  assert.equal(packets.length, run.context?.packets?.length,
    'source run contains an unexpected or undelivered packet');
  assert.equal(reads.length, allReads.length,
    'source run contains an unrelated or undelivered read-completed event');
  assert.ok(named.length > 0 && named.length === packets.length && packets.length === reads.length,
    'named native egdesk_read_source calls and delivered packet receipts are incomplete');
  assert.equal(new Set(named.map(item => item.id)).size, named.length,
    'native source-read item IDs are not distinct');
  assert.equal(new Set(packets.map(item => item.packetId)).size, packets.length,
    'delivered source packet IDs are not distinct');
  assert.equal(new Set(packets.map(item => item.receiptId)).size, packets.length,
    'delivered source receipt IDs are not distinct');
  const matched = packets.map(packet => {
    const corresponding = reads.filter(event => event.details?.receiptId === packet.receiptId
      && event.details?.packetId === packet.packetId
      && named.some(item => item.id === event.itemId));
    assert.equal(corresponding.length, 1,
      'run packet is not uniquely bound to source, native call and delivery receipt');
    const read = corresponding[0];
    assert.ok(['direct', 'reader'].includes(packet.mode) && packet.mode === read.details.mode
      && packet.coverage && packet.coverage.sourceTruncated === false,
    'SmartRead admission/coverage is unavailable or truncated');
    return { packet, read };
  });
  assert.equal(new Set(matched.map(item => item.read.itemId)).size, named.length,
    'native source-read call lacks a distinct delivered packet');
  assert.ok(matched.every((item, index) => Number.isSafeInteger(item.read.seq)
    && (index === 0 || item.read.seq > matched[index - 1].read.seq)),
  'source packet order differs from actual SSE delivery order');
  const latest = matched.at(-1);
  assert.equal(stored?.delivered?.packetId, latest.packet.packetId,
    'immutable inspector does not show the latest delivered packet of this run');
  assert.equal(stored?.delivered?.deliveryStatus, 'sent-to-app-server', 'inspector packet was not delivered');
  assert.equal(stored?.delivered?.binding?.conversationId, run.conversationId,
    'inspector latest packet belongs to another conversation');
  assert.equal(stored?.delivered?.binding?.runId, run.runId,
    'inspector latest packet belongs to another run');
  assert.equal(stored?.delivered?.binding?.answerId, run.answerId,
    'inspector latest packet belongs to another answer');
  const answer = (run.messages || []).filter(item => item.role === 'assistant').map(item => item.text || '').join('\n');
  assert.ok(answer.includes(originalNonce) && !answer.includes(changedNonce),
    'answer did not distinguish immutable original from changed live file');
  return { sourceId: reference.sourceId, nativeCallId: latest.read.itemId,
    packetId: latest.packet.packetId, readMode: latest.packet.mode, readCount: matched.length };
}

// B's Card selection/call projection remains a seam until its final public
// receipts land. Native provider/active-run/policy checks use actual SSE/state.
export function assertBrowserToolFlow({ run, events, active, calls, selection, target, control, before, after }) {
  assertObservedRunChain({ run, events, active });
  const policy = run.executionPolicy;
  assert.equal(policy?.mode, 'fixtureBrowserQa',
    'Browser write actions need A attested local-fixture policy');
  assert.equal(policy?.status, 'native-thread-verified', 'Browser native policy was not verified');
  assert.equal(policy?.sandbox, 'readOnly', 'Browser native sandbox is not read-only');
  assert.equal(policy?.approvalPolicy, 'never', 'Browser native approval policy is not noninteractive');
  assert.equal(policy?.networkAccess, false, 'Browser native network access is not disabled');
  assert.equal(policy?.externalMcpCatalog, 'empty', 'Browser native external MCP catalog is not empty');
  assert.equal(policy?.browserEffects, 'attested-local-fixture-only',
    'Browser policy has no attested local-fixture effect boundary');
  assert.equal(selection?.selectedByUser, true, 'Browser selection was not explicit');
  assert.equal(selection?.permission, 'interact', 'Browser write-act was not permitted');
  assert.equal(selection?.cardId, target.cardId, 'Browser grant belongs to another card');
  assert.equal(selection?.profileId, target.profileId, 'Browser grant belongs to another profile');
  assert.ok(typeof selection?.cardEpoch === 'string' && selection.cardEpoch,
    'Browser UI selection has no Card epoch');
  assert.ok(typeof selection?.sourceId === 'string' && selection.sourceId,
    'Browser UI selection has no source ID');
  const binding = run.browserBinding;
  assert.equal(binding?.cards?.length, 1, 'native run has no single-card Browser binding');
  assert.equal(binding.cards[0].cardId, target.cardId, 'native Browser binding targets another card');
  assert.equal(binding.cards[0].permission, 'interact', 'native Browser binding lost interaction permission');
  assert.equal(binding.cards[0].cardEpoch, selection.cardEpoch, 'native Browser binding crossed Card epochs');
  assert.equal(binding.cards[0].sourceId, selection.sourceId, 'native Browser binding targets another source');
  assert.ok(events.some(event => event.event === 'browser.bound' && event.runId === run.runId
    && same(event.details, binding)), 'native Browser binding SSE receipt is missing');
  assert.ok(Array.isArray(calls) && calls.length >= 5, 'browser model tool receipts are unavailable');
  const activities = new Map((run.activities || []).filter(item => item.kind === 'dynamicToolCall')
    .map(item => [item.id, item]));
  const epochs = new Set();
  for (const call of calls) {
    assert.equal(call.origin, 'native-dynamic-tool', 'browser action is not a native model tool call');
    assert.equal(call.conversationId, run.conversationId, 'browser call belongs to another conversation');
    assert.equal(call.runId, run.runId, 'browser call belongs to another run');
    assert.equal(call.toolName, BROWSER_TOOL_NAMES[call.kind], 'Browser call is not one of B native tools');
    assert.equal(activities.get(call.itemId)?.detail?.tool, call.toolName,
      'browser tool call has no matching named native activity event');
    assert.equal(call.cardId, target.cardId, 'browser tool targeted the wrong card');
    assert.equal(call.profileId, target.profileId, 'browser tool targeted the wrong Browser profile');
    assert.equal(call.targetCardEpoch, selection.cardEpoch, 'Browser tool call crossed Card epochs');
    assert.equal(call.sourceId, selection.sourceId, 'Browser tool call used a different source');
    assert.ok(Number.isSafeInteger(call.bridgeEpoch) && call.bridgeEpoch >= 0,
      'Browser tool call has no native bridge epoch');
    epochs.add(call.bridgeEpoch);
    assert.ok(events.some(event => ['browser.tool.completed', 'browser.tool.failed'].includes(event.event)
      && event.runId === run.runId && event.itemId === call.itemId
      && event.details?.originalProviderId === 'egdesk-browser'
      && event.details?.cardId === target.cardId
      && event.details?.sourceId === selection.sourceId
      && event.details?.targetCardEpoch === selection.cardEpoch
      && event.details?.bridgeEpoch === call.bridgeEpoch),
    'Browser native tool receipt is not bound to this item/Card/source/epoch');
    assert.ok(call.documentRevision, 'browser tool lacks document revision binding');
    assert.notEqual(call.fixtureOnly, true, 'fixture tool call is not real evidence');
  }
  assert.equal(epochs.size, 1, 'Browser tool calls crossed native bridge epochs');
  const observeBefore = calls.find(item => item.kind === 'observe' && item.status === 'completed');
  const click = calls.find(item => item.kind === 'click' && item.status === 'completed'
    && item.observationId === observeBefore?.observationId);
  const stale = calls.find(item => item.kind === 'click' && item.status === 'rejected'
    && item.code === 'BROWSER_OBSERVATION_STALE' && item.observationId === observeBefore?.observationId
    && item.documentRevision !== click?.resultRevision);
  const observeAfter = calls.find(item => item.kind === 'observe' && item.status === 'completed'
    && item.documentRevision === click?.resultRevision && item.observationId !== observeBefore?.observationId);
  const fill = calls.find(item => item.kind === 'fill' && item.status === 'completed'
    && item.observationId === observeAfter?.observationId && item.resultValue === target.fillValue);
  assert.ok(observeBefore && click && stale && observeAfter && fill,
    'observe/click/stale-reject/re-observe/fill native tool sequence is incomplete');
  assert.ok(Array.isArray(click.changedNodes) && click.changedNodes.some(node => node.text === 'Newly revealed node'),
    'click receipt lacks changed-node evidence');
  assert.ok(!stale.changedNodes?.length && !stale.resultRevision,
    'stale-observation rejection reported an applied mutation');
  assert.ok(before.targetText.includes('Waiting for QA action') && !before.targetText.includes('Changed by QA click'),
    'target DOM baseline is not the local fixture');
  assert.ok(before.targetSegments?.includes(target.fixtureMarker)
    && after.targetSegments?.includes(target.fixtureMarker),
  'exact Browser fixture marker did not persist across the model action');
  assert.ok(after.targetText.includes('Changed by QA click') && after.targetText.includes('Newly revealed node'),
    'changed node is not in independently observed target DOM');
  assert.equal(after.inputValue, target.fillValue, 'harmless input value did not change');
  assert.notEqual(after.focusedCardId, control.cardId, 'Browser action focused the wrong card');
  assert.equal(before.controlText, after.controlText, 'wrong-card DOM changed');
  assert.equal(before.controlInputValue, after.controlInputValue, 'wrong-card input changed');
  assert.equal(control.cardId, before.controlCardId, 'control card identity was not observed');
  assert.ok(same(before.camera, after.camera), 'Browser tool moved Canvas pan/zoom');
  assert.ok(same(before.cards, after.cards), 'Browser tool opened/closed or reordered cards');
  return { cardId: target.cardId, observeItemId: observeBefore.itemId,
    clickItemId: click.itemId, staleItemId: stale.itemId, fillItemId: fill.itemId,
    inputFocusedAfter: after.targetInputFocused === true };
}

// The currently public A contract proves model-tool dispatch/binding and its
// bounded status, not target revision, DOM diff or post-stop nonexecution.
// Keep this distinct from the stronger browserToolReceipts/negative-guard seam.
export function assertPublicBrowserSseBindings({ run, events, active, selection }) {
  assertObservedRunChain({ run, events, active });
  assert.equal(run.executionPolicy?.mode, 'fixtureBrowserQa', 'Browser run is not in fixture QA mode');
  assert.equal(run.executionPolicy?.browserEffects, 'attested-local-fixture-only',
    'Browser run lacks the native fixture effect boundary');
  const binding = run.browserBinding;
  assert.equal(binding?.cards?.length, 1, 'public Browser binding does not contain exactly one Card');
  assert.equal(binding.cards[0].cardId, selection.cardId, 'public Browser binding targets another Card');
  assert.equal(binding.cards[0].sourceId, selection.sourceId, 'public Browser binding targets another source');
  assert.equal(binding.cards[0].cardEpoch, selection.cardEpoch, 'public Browser binding crossed Card epochs');
  assert.equal(binding.cards[0].permission, 'interact', 'public Browser binding lacks interaction permission');
  assert.ok(events.some(event => event.event === 'browser.bound' && event.runId === run.runId
    && same(event.details, binding)), 'public Browser bind event is missing');
  const names = new Map((run.activities || []).filter(item => item.kind === 'dynamicToolCall')
    .map(item => [item.id, item.detail?.tool]));
  const toolEvents = events.filter(event => ['browser.tool.completed', 'browser.tool.failed',
    'browser.tool.unverified'].includes(event.event));
  assert.ok(toolEvents.length >= 4, 'public Browser tool events are incomplete');
  const epochs = new Set();
  for (const event of toolEvents) {
    assert.equal(event.provider, 'codex', 'public Browser tool event is not a Codex event');
    assert.equal(event.requestId, run.requestId, 'public Browser tool event belongs to another send');
    assert.equal(event.clientThreadId, run.clientThreadId, 'public Browser tool event belongs to another Chat thread');
    assert.equal(event.conversationId, run.conversationId, 'public Browser tool event belongs to another conversation');
    assert.equal(event.runId, run.runId, 'public Browser tool event belongs to another run');
    assert.equal(event.details?.callId, event.itemId, 'public Browser call ID differs from native item ID');
    assert.equal(event.details?.originalProviderId, 'egdesk-browser',
      'public Browser event came from another tool provider');
    assert.equal(event.details?.namespace, null, 'public Browser event used another namespace');
    assert.equal(event.details?.cardId, selection.cardId, 'public Browser event targeted another Card');
    assert.equal(event.details?.sourceId, selection.sourceId, 'public Browser event targeted another source');
    assert.equal(event.details?.targetCardEpoch, selection.cardEpoch,
      'public Browser event crossed Card epochs');
    assert.ok(Number.isSafeInteger(event.details?.bridgeEpoch) && event.details.bridgeEpoch >= 0,
      'public Browser event has no bridge epoch');
    epochs.add(event.details.bridgeEpoch);
    assert.ok(Object.values(BROWSER_TOOL_NAMES).includes(names.get(event.itemId)),
      'public Browser event has no named native dynamic-tool item');
  }
  assert.equal(epochs.size, 1, 'public Browser tool events crossed bridge epochs');
  const find = (tool, eventName, predicate = () => true) => toolEvents.find(event =>
    names.get(event.itemId) === tool && event.event === eventName && predicate(event.details));
  const observe = find(BROWSER_TOOL_NAMES.observe, 'browser.tool.completed', details => details.status === 'observed');
  const click = find(BROWSER_TOOL_NAMES.click, 'browser.tool.completed', details =>
    details.status === 'postcondition-observed' && details.action === 'click'
      && details.postconditionMatched === true);
  const fill = find(BROWSER_TOOL_NAMES.fill, 'browser.tool.completed', details =>
    details.status === 'postcondition-observed' && details.action === 'fill'
      && details.postconditionMatched === true);
  const stale = find(BROWSER_TOOL_NAMES.click, 'browser.tool.failed', details =>
    details.code === 'BROWSER_OBSERVATION_STALE');
  assert.ok(observe && click && fill && stale,
    'public Browser observe/click/fill/stale-rejection sequence is incomplete');
  return { cardId: selection.cardId, publicEventBindingVerified: true,
    observeItemId: observe.itemId, clickItemId: click.itemId,
    fillItemId: fill.itemId, staleItemId: stale.itemId,
    domRevisionVerified: false, postStopNonexecutionVerified: false };
}

export function assertBrowserSameChatAddition({ firstRun, laterRun, firstCompletedAt, laterSelectedAt,
  firstCardId, laterCardId, laterSelection, before, after }) {
  assert.ok(firstRun?.conversationId && firstRun.conversationId === laterRun?.conversationId,
    'later Browser target was not added to the same native Chat');
  assert.notEqual(firstRun.runId, laterRun.runId, 'later Browser target did not use a new turn');
  assert.ok(Number.isFinite(firstCompletedAt) && Number.isFinite(laterSelectedAt)
    && laterSelectedAt > firstCompletedAt, 'later card selection did not happen after the first turn');
  assert.notEqual(firstCardId, laterCardId, 'later Browser target reused the first card');
  assert.equal(laterSelection?.cardId, laterCardId, 'later target selection is not bound to its card');
  assert.equal(laterSelection?.permission, 'interact', 'later target has no explicit interaction grant');
  assert.ok(typeof before?.firstCardText === 'string' && before.camera && after?.camera,
    'same-Chat independent first-card observations are missing');
  assert.equal(before?.firstCardText, after?.firstCardText, 'first card changed during later-card turn');
  assert.ok(same(before?.camera, after?.camera), 'later-card turn moved pan/zoom or active card');
  return true;
}

export function assertBrowserFixtureConfig(url, marker) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('Browser fixture URL is invalid'); }
  assert.equal(parsed.protocol, 'http:', 'Browser fixture must use HTTP');
  assert.ok(['127.0.0.1', '[::1]'].includes(parsed.hostname),
    'Browser fixture must use an exact loopback host');
  assert.ok(Number(parsed.port) >= 1024 && Number(parsed.port) <= 65535,
    'Browser fixture must use a Main-leased nonprivileged port');
  assert.ok(!parsed.username && !parsed.password && !parsed.search && !parsed.hash,
    'Browser fixture cannot contain credentials, query or fragment');
  const pathMarker = parsed.pathname.match(/^\/egdesk-qa\/([A-Za-z0-9_-]{20,80})$/)?.[1];
  assert.ok(pathMarker && url === parsed.href, 'Browser fixture URL is not the exact canonical QA path');
  assert.match(marker, /^[A-Za-z0-9_-]{20,80}$/, 'Browser DOM fixture marker is invalid');
  assert.notEqual(marker, pathMarker, 'Browser DOM marker must differ from the URL path marker');
  return { url, marker, pathMarker };
}

export function browserFixtureHtml(marker) {
  assert.match(marker, /^[A-Za-z0-9_-]{20,80}$/, 'Browser DOM fixture marker is invalid');
  return `<!doctype html><html><head><meta charset="utf-8"><title>EG-Desk public local QA fixture</title>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'; form-action 'none'; base-uri 'none'">
<style>body{font:16px system-ui;padding:32px}button,input{font:inherit;padding:8px;margin:8px}</style></head>
<body><main><h1>EG-Desk local Browser QA</h1><p id="fixture-marker">${marker}</p>
<p id="qa-state">Waiting for QA action</p><label for="qa-input">QA note</label>
<input id="qa-input" aria-label="QA note" type="text" autocomplete="off">
<button id="qa-button" type="button">Reveal QA details</button><span id="qa-click-count">QA click count: 0</span>
<div id="qa-guard-controls" style="display:flex;flex-wrap:wrap">
<input aria-label="QA readonly note" type="text" readonly autocomplete="off" style="width:130px">
<fieldset disabled style="border:0;padding:0;margin:0"><input aria-label="QA fieldset note" type="text" autocomplete="off" style="width:130px"></fieldset>
<div aria-disabled="true"><input aria-label="QA ancestor note" type="text" autocomplete="off" style="width:130px"></div>
</div><section id="qa-changed"></section></main>
<script>let qaClicks=0;document.getElementById('qa-button').addEventListener('click',()=>{
document.getElementById('qa-state').textContent='Changed by QA click';
document.getElementById('qa-click-count').textContent='QA click count: '+(++qaClicks);
const node=document.createElement('p');node.textContent='Newly revealed node';
document.getElementById('qa-changed').appendChild(node)});</script></body></html>`;
}

export async function assertBrowserFixtureServerReady(fixture, fetchImpl = fetch) {
  assertBrowserFixtureConfig(fixture?.url, fixture?.marker);
  const response = await fetchImpl(fixture.url, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  assert.equal(response?.status, 200, 'owned Browser fixture server did not return 200');
  assert.equal(response?.url, fixture.url, 'owned Browser fixture request changed URL');
  assert.match(response?.headers?.get?.('content-type') || '', /^text\/html(?:;|$)/i,
    'owned Browser fixture is not HTML');
  assert.equal(await response.text(), browserFixtureHtml(fixture.marker),
    'owned Browser fixture body differs from the bounded local document');
  return true;
}

export function createBrowserFixtureHandler({ port, pathMarker, marker }) {
  assert.ok(Number.isSafeInteger(port) && port >= 1024 && port <= 65535
    && ![39218, 39219, 2828, 6000].includes(port),
  'Browser fixture port must be separately leased by Main');
  const url = `http://127.0.0.1:${port}/egdesk-qa/${pathMarker}`;
  assertBrowserFixtureConfig(url, marker);
  const body = browserFixtureHtml(marker);
  const pathOnly = `/egdesk-qa/${pathMarker}`;
  return { url, marker, handle(request, response) {
    if (request.headers?.host !== `127.0.0.1:${port}` || request.url !== pathOnly) {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end('Not found');
      return;
    }
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET', 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Method not allowed');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' });
    response.end(body);
  } };
}

async function serveBrowserFixture() {
  const deadlineMs = parseDeadlineUtc(required(option('--deadline-utc'), '--deadline-utc is required'));
  assertBeforeDeadline(deadlineMs);
  const port = Number(required(option('--browser-fixture-port'), '--browser-fixture-port is required'));
  const pathMarker = option('--browser-fixture-path-marker') || `QA_URL_${randomBytes(12).toString('hex')}`;
  const marker = option('--browser-fixture-marker') || `QA_DOM_${randomBytes(12).toString('hex')}`;
  const fixture = createBrowserFixtureHandler({ port, pathMarker, marker });
  const server = createServer(fixture.handle);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  process.stdout.write(`${JSON.stringify({ kind: 'egdesk-browser-qa-fixture', url: fixture.url,
    marker: fixture.marker, listening: true, pid: process.pid })}\n`);
  const stopAtDeadline = () => {
    if (Date.now() >= deadlineMs) { server.close(); return; }
    setTimeout(stopAtDeadline, Math.min(60000, deadlineMs - Date.now())).unref?.();
  };
  stopAtDeadline();
}

export function assertBrowserNegativeGuards({ guards, cardId, profileId, stoppedAt,
  navigationFixtureUrl, fixtureMarker }) {
  assertBrowserFixtureConfig(navigationFixtureUrl, fixtureMarker);
  const names = ['dom-stale', 'viewport-stale', 'cancel-before-act',
    'scheme-denial-data', 'scheme-denial-file', 'scheme-denial-javascript',
    'permission-escalation', 'expired-after-stop', 'cancelled-after-stop'];
  assert.ok(Array.isArray(guards) && guards.length === names.length,
    'nine live Browser guard receipts are required');
  for (const name of names) {
    const receipt = guards.find(item => item?.case === name);
    assert.ok(receipt, `missing live Browser guard: ${name}`);
    const rejectedBeforeUi = name.startsWith('scheme-denial-') || name === 'permission-escalation';
    assert.equal(receipt.origin, rejectedBeforeUi ? 'native-dynamic-tool-rejection' : 'live-browser-tool-transport',
      `${name} has the wrong rejection boundary`);
    if (rejectedBeforeUi) assert.ok(typeof receipt.nativeItemId === 'string' && receipt.nativeItemId,
      `${name} lacks a native model-tool item ID`);
    assert.equal(receipt.cardId, cardId, `${name} targeted a different card`);
    assert.equal(receipt.profileId, profileId, `${name} targeted a different profile`);
    assert.ok(typeof receipt.requestId === 'string' && receipt.requestId
      && typeof receipt.runId === 'string' && receipt.runId,
    `${name} has no live request/run identity`);
    assert.equal(receipt.status, 'rejected', `${name} unexpectedly applied an action`);
    assert.ok(Number.isSafeInteger(receipt.actorDispatchesBefore) && receipt.actorDispatchesBefore >= 0
      && Number.isSafeInteger(receipt.actorDispatchesAfter) && receipt.actorDispatchesAfter >= 0,
    `${name} has no actor-dispatch counter`);
    assert.equal(receipt.actorDispatchesAfter, receipt.actorDispatchesBefore,
      `${name} reached the actor despite rejection`);
    assert.ok(receipt.beforeAttempt && receipt.afterAttempt,
      `${name} has no independent before/after fixture observation`);
    assert.ok(same(receipt.beforeAttempt, receipt.afterAttempt), `${name} changed the owned fixture after rejection`);
    if (name === 'cancel-before-act') assert.ok(receipt.cancelReceipt?.status === 'cancelled'
      && receipt.cancelReceipt.runId === receipt.runId && receipt.cancelReceipt.cardId === cardId
      && Number.isFinite(receipt.cancelReceipt.at) && receipt.cancelReceipt.at < receipt.attemptedAt,
    'cancel-before-act has no earlier owned cancellation receipt');
    if (name.startsWith('scheme-denial-')) {
      const scheme = name.slice('scheme-denial-'.length);
      let attempted;
      try { attempted = new URL(receipt.attemptedUrl); } catch { throw new Error(`${name} has no parseable attempted URL`); }
      assert.equal(attempted.protocol, `${scheme}:`, `${name} did not test its denied scheme`);
      assert.equal(receipt.attemptedTool, 'egdesk_browser_navigate',
        `${name} was not a model Browser navigate request`);
      assert.equal(receipt.errorCode, 'INVALID_BROWSER_TOOL',
        `${name} was not rejected by B's URL-schema boundary`);
      assert.equal(receipt.beforeAttempt.url, receipt.afterAttempt.url,
        `${name} changed the Browser URL`);
    }
    if (name === 'permission-escalation') {
      assert.equal(receipt.selectedPermission, 'observe',
        'permission-escalation was not attempted from a read-only Browser selection');
      assert.ok(['egdesk_browser_click', 'egdesk_browser_fill', 'egdesk_browser_navigate']
        .includes(receipt.attemptedTool), 'permission-escalation did not attempt a write action');
      assert.equal(receipt.errorCode, 'BROWSER_INTERACTION_NOT_GRANTED',
        "permission-escalation was not denied by B's permission boundary");
      assert.equal(receipt.permissionAfter, 'observe', 'model elevated Browser permission');
    }
    if (name.endsWith('after-stop')) assert.ok(Number.isFinite(stoppedAt)
      && receipt.attemptedAt > stoppedAt && receipt.cancelReceipt?.status === 'cancelled'
      && receipt.cancelReceipt.runId === receipt.runId && receipt.cancelReceipt.cardId === cardId,
    `${name} lacks a preceding owned-run cancellation receipt`);
  }
  return true;
}

function fileInventory(root) {
  return Object.fromEntries(fs.readdirSync(root).sort().map(name => {
    const file = path.join(root, name);
    const info = fs.lstatSync(file, { bigint: true });
    assert.ok(info.isFile() && !info.isSymbolicLink(), `QA fixture must be a regular file: ${name}`);
    return [file, { sha256: sha256(fs.readFileSync(file)), size: Number(info.size),
      mode: Number(info.mode & 0o777n), mtimeNs: String(info.mtimeNs), ctimeNs: String(info.ctimeNs) }];
  }));
}

function createQaRunDirectory(root) {
  const canonicalRoot = fs.realpathSync.native(root);
  assert.equal(canonicalRoot, root, 'QA fixture root must be canonical');
  const created = fs.mkdtempSync(path.join(root, 'lane-c-'));
  const canonical = fs.realpathSync.native(created);
  assert.equal(path.dirname(canonical), root, 'QA run directory escaped the dedicated fixture root');
  fs.chmodSync(canonical, 0o700);
  return canonical;
}

function existingQaRunDirectory(root, candidate) {
  assert.equal(fs.realpathSync.native(root), root, 'QA real-turn root is not canonical');
  assert.equal(path.dirname(candidate), root, 'prepared source fixture escaped the real-turn root');
  assert.match(path.basename(candidate), /^lane-c-[A-Za-z0-9]{6}$/,
    'prepared source fixture is not one Lane C run directory');
  const info = fs.lstatSync(candidate);
  assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid()
    && (info.mode & 0o077) === 0,
  'prepared source fixture directory is not private and user-owned');
  assert.equal(fs.realpathSync.native(candidate), candidate,
    'prepared source fixture directory is not canonical');
  return candidate;
}

function makeFixtures(root) {
  assert.deepEqual(fs.readdirSync(root), [], 'dedicated real-turn cwd must be empty');
  const nativeNonce = `QA_NATIVE_${randomBytes(12).toString('hex')}`;
  const sourceNonce = `QA_SOURCE_ORIGINAL_${randomBytes(12).toString('hex')}`;
  const changedNonce = `QA_SOURCE_LIVE_${randomBytes(12).toString('hex')}`;
  const commandTag = `QA_COMMAND_${randomBytes(6).toString('hex')}`;
  const nativeFile = path.join(root, 'native-read.txt');
  const sourceFile = path.join(root, 'source-read.txt');
  fs.writeFileSync(nativeFile, `Public EG-Desk native QA fixture.\n${nativeNonce}\n`, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(sourceFile, `Public EG-Desk source QA fixture.\n${sourceNonce}\n`, { flag: 'wx', mode: 0o600 });
  // Browser model QA uses only the separately attested loopback HTTP fixture.
  return { nativeFile, sourceFile, nativeNonce, sourceNonce, changedNonce, commandTag };
}

async function assertBridgePreflight() {
  const health = await loopbackJson('/health');
  const auth = (await loopbackJson('/v1/state')).auth;
  const endpoint = await fetch('http://127.0.0.1:39218/__qa/state', {
    redirect: 'error', signal: AbortSignal.timeout(5000) });
  assertRealTransport({ realTurn: process.env.EGDESK_QA_REAL_TURN,
    fixtureTransport: process.env.EGDESK_QA_FIXTURE_TRANSPORT,
    health, auth, fixtureEndpointStatus: endpoint.status });
  return { health, auth };
}

export function assertNativeQaCapabilityBeforeTurn(health) {
  assert.equal(health?.native?.schemaMatch, true, 'native generated schema is not verified');
  assert.equal(health?.native?.qaReadOnly, true, 'native bounded QA policy is not available');
  assert.match(health?.native?.contractFingerprint || '', /^[a-f0-9]{64}$/,
    'native binary/schema contract fingerprint is unavailable');
  return health.native.contractFingerprint;
}

// A accepts executionPolicy:{mode:'readOnlyQa'} on /chat/send and verifies the
// native thread response before turn/start. Current UI buildChatRequest does
// not yet emit that field. Main/A must connect a dedicated QA-thread setting
// to the ordinary rendered-composer path. We refuse the turn until reflection
// proves that the actual UI request includes the exact A policy selector.
export function assertOrdinaryUiBaseline(reflection, cwd) {
  assert.equal(reflection?.cwd, cwd, 'normal Chat request uses a different cwd');
  assert.equal(reflection?.profileEnabled, false, 'QA must use ordinary Chat');
  assert.deepEqual(reflection?.personaFields, [], 'ordinary QA request includes persona fields');
  return true;
}

export function assertUiQaRequest(emitted, { cwd, clientThreadId, conversationId = null,
  sourceIds = [], qaOutputMarkers = [] } = {}) {
  assert.equal(emitted?.forwardedToOriginalFetch, true,
    'QA request was not forwarded through the original Chat fetch');
  assert.equal(emitted?.route, 'http://127.0.0.1:39218/chat/send',
    'QA request did not use the production Chat route');
  assert.ok(typeof emitted?.requestId === 'string' && emitted.requestId,
    'QA request lacks a live request ID');
  assert.equal(emitted?.clientThreadId, clientThreadId, 'QA request belongs to another Chat thread');
  assert.equal(emitted?.conversationId || null, conversationId, 'QA request belongs to another native conversation');
  assert.equal(emitted?.messageMatched, true, 'QA composer message was not the expected prompt');
  assertOrdinaryUiBaseline(emitted, cwd);
  assert.deepEqual(emitted?.contextSnapshotIds || [], sourceIds, 'QA source IDs were not selected');
  assert.deepEqual(emitted?.executionPolicy, { mode: 'readOnlyQa' },
    'normal Chat fetch did not emit A readOnlyQa executionPolicy');
  assert.equal(emitted?.qaCommandNonce || null, null,
    'normal Chat fetch used the legacy single-nonce field');
  assert.ok(Array.isArray(qaOutputMarkers) && qaOutputMarkers.length <= 4
    && qaOutputMarkers.every(marker => /^[A-Za-z0-9_-]{20,80}$/.test(marker))
    && new Set(qaOutputMarkers).size === qaOutputMarkers.length,
  'QA output markers are not distinct bounded public ASCII tokens');
  assert.deepEqual(emitted?.qaOutputMarkers || [], qaOutputMarkers,
    'normal Chat fetch did not bind the two distinct public QA output markers');
  if (qaOutputMarkers.length) assert.equal(emitted?.hiddenMarkerAbsentFromModelAdmission, true,
    'file-content marker leaked into model-facing admission');
  return true;
}

// This is request reflection, not a permission grant. A/B's final UI routing
// must put these exact bounded fields on the ordinary rendered Chat send.
export function assertBrowserUiRequest(reflection, { cwd, clientThreadId, conversationId = null, selection,
  expectedPolicyMode = 'fixtureBrowserQa' }) {
  assert.ok(['fixtureBrowserQa', 'browserBounded'].includes(expectedPolicyMode), 'unsupported Browser proof policy');
  assert.equal(reflection?.forwardedToOriginalFetch, true,
    'Browser request was not forwarded through the original Chat fetch');
  assert.equal(reflection?.route, 'http://127.0.0.1:39218/chat/send',
    'Browser request did not use the production Chat route');
  assert.ok(typeof reflection?.requestId === 'string' && reflection.requestId,
    'Browser request lacks a live request ID');
  assert.equal(reflection?.clientThreadId, clientThreadId,
    'Browser request belongs to another Chat thread');
  assert.equal(reflection?.messageMatched, true, 'Browser composer message was not the expected prompt');
  assert.equal(reflection?.cwd, cwd, 'Browser Chat request uses another cwd');
  assert.equal(reflection?.profileEnabled, false, 'Browser QA must use ordinary Chat');
  assert.deepEqual(reflection?.personaFields, [], 'Browser QA request includes persona fields');
  assert.equal(reflection?.conversationId || null, conversationId,
    'Browser QA request targets another native conversation');
  assert.equal(reflection?.executionPolicy?.mode, expectedPolicyMode,
    'Browser write action lacks A bounded native execution policy');
  if (expectedPolicyMode === 'browserBounded') {
    assert.deepEqual(reflection.executionPolicy, { mode: 'browserBounded' },
      'ordinary Browser UI did not emit its exact bounded policy');
    assert.equal(reflection.requestBodyUnmodified, true,
      'ordinary Browser proof requires an unmodified original fetch body');
    assert.equal(reflection.qaCommandNonce || null, null, 'ordinary Browser request used a QA command nonce');
    assert.deepEqual(reflection.qaOutputMarkers || [], [], 'ordinary Browser request used QA output markers');
  }
  assert.ok(typeof reflection?.browserTransportId === 'string' && reflection.browserTransportId,
    'Browser QA request has no live UI transport binding');
  assert.equal(reflection?.selectedSources?.length, 1, 'Browser QA request must select exactly one card');
  const source = reflection.selectedSources[0];
  assert.equal(source.kind, 'browser', 'Browser QA selected a non-Browser source');
  assert.equal(source.sourceId, selection.sourceId, 'Browser QA request selected another source');
  assert.equal(source.cardId, selection.cardId, 'Browser QA request selected another card');
  assert.equal(source.profileId, selection.profileId, 'Browser QA request selected another profile');
  assert.equal(source.uri, selection.uri, 'Browser QA request selected another URL');
  assert.equal(source.accountId, '', 'Browser QA request selected an account-linked Card');
  assert.equal(source.permission, 'interact', 'Browser QA request did not retain explicit interact permission');
  assert.equal(source.selectedByUser, true, 'Browser QA request lost UI selection');
  assert.equal(source.hasOneTimeToken, true, 'Browser QA request lacks a one-time source token');
  assert.equal(source.tokenThreadId, clientThreadId, 'Browser QA token belongs to another Chat thread');
  assert.equal(source.cardEpoch, selection.cardEpoch,
    'Browser QA request crossed the selected Card generation');
  return true;
}

export function assertFreshBrowserRootSse({ ready, emitted = null, now = Date.now() }) {
  assert.equal(ready?.sourceReady, true, 'root Browser SSE has not received a ready event');
  assert.equal(ready?.stable, true, 'root Browser SSE is not bound to the current listener');
  assert.equal(ready?.eventSourceReadyState, 1, 'root Browser SSE is not OPEN');
  assert.ok(typeof ready?.browserTransportId === 'string' && ready.browserTransportId,
    'root SSE ready event has no Browser transport ID');
  if (!emitted) assert.ok(Number.isFinite(ready?.sampledAtMs) && ready.sampledAtMs <= now
    && now - ready.sampledAtMs <= 5000, 'root SSE Browser transport sample is stale');
  else {
    assert.equal(emitted.browserTransportId, ready.browserTransportId,
      'Chat send did not use this root SSE Browser transport');
    assert.equal(emitted.rootSseStable, true, 'root SSE was not stable at the original Chat fetch');
    assert.equal(emitted.rootSseReadyState, 1, 'root SSE was not OPEN at the original Chat fetch');
    assert.ok(Number.isFinite(emitted.rootSseCheckedAtMs)
      && Number.isFinite(emitted.rootSseSampledAtMs)
      && emitted.rootSseSampledAtMs >= ready.sampledAtMs
      && emitted.rootSseSampledAtMs <= emitted.rootSseCheckedAtMs
      && emitted.rootSseCheckedAtMs - emitted.rootSseSampledAtMs <= 5000,
    'root SSE Browser transport was not freshly sampled before original fetch');
  }
  return true;
}

async function browserRootSseReceiptBeforeTurn(harness, deadlineMs) {
  const ready = await waitUntil(async () => {
    assertBeforeDeadline(deadlineMs);
    return chrome(harness, () => {
      const status = window.__egdesk?.browserAgentTools?.rootSseReady?.();
      if (!status) return null;
      return { sourceReady: status.sourceReady === true,
        stable: status.stable === true,
        eventSourceReadyState: status.eventSourceReadyState,
        browserTransportId: status.browserTransportId || null,
        sampledAtMs: status.sampledAtMs, checkedAtMs: Date.now() };
    });
  }, value => value?.sourceReady === true && value.stable === true
    && value.eventSourceReadyState === 1 && typeof value.browserTransportId === 'string'
    && !!value.browserTransportId && Number.isFinite(value.sampledAtMs)
    && Number.isFinite(value.checkedAtMs) && value.checkedAtMs <= Date.now()
    && value.sampledAtMs <= value.checkedAtMs
    && value.checkedAtMs - value.sampledAtMs <= 5000,
  { timeoutMs: 30000, intervalMs: 200 });
  // Compare clocks at the observation, not after Windows ACL/MCP round trips.
  // The original product fetch independently rechecks freshness and identity.
  assertFreshBrowserRootSse({ ready, now: ready.checkedAtMs });
  return ready;
}

async function browserExecutionAuthorityBeforeTurn(harness, thread, selection, health, cwd,
  deadlineMs, expectedConversationId = null) {
  assertNativeQaCapabilityBeforeTurn(health);
  const reflected = await reflectedOrdinaryRequest(harness, thread, cwd, [], { allowExisting: true });
  assertOrdinaryUiBaseline(reflected, cwd);
  assert.equal(reflected.conversationId || null, expectedConversationId,
    'Browser Chat baseline targets another native conversation');
  assert.equal(selection?.selectedByUser, true, 'Browser Card was not selected through the UI');
  assert.equal(selection?.permission, 'interact', 'Browser Card lacks an explicit interact selection');
  return browserRootSseReceiptBeforeTurn(harness, deadlineMs);
}

// Only fields A actually publishes on v2 SSE and native activity projections.
// A postcondition flag is local-page evidence, never external-effect proof.
export function browserToolReceipts(run, events) {
  const activities = new Map((run?.activities || [])
    .filter(item => item.kind === 'dynamicToolCall').map(item => [item.id, item]));
  return (events || []).filter(event => ['browser.tool.completed', 'browser.tool.unverified',
    'browser.tool.failed'].includes(event.event)).map(event => {
    const activity = activities.get(event.itemId);
    const details = event.details || {};
    assert.equal(event.type, 'chat.event', 'Browser receipt is not a v2 Chat event');
    assert.equal(event.v, 2, 'Browser receipt uses another Chat protocol');
    assert.equal(event.provider, 'codex', 'Browser receipt came from another model provider');
    assert.equal(event.requestId, run.requestId, 'Browser receipt belongs to another UI send');
    assert.equal(event.clientThreadId, run.clientThreadId, 'Browser receipt belongs to another Chat thread');
    assert.equal(event.conversationId, run.conversationId, 'Browser receipt belongs to another conversation');
    assert.equal(event.runId, run.runId, 'Browser receipt belongs to another run');
    assert.equal(details.callId, event.itemId, 'Browser callback ID differs from native item ID');
    assert.ok(activity && Object.values(BROWSER_TOOL_NAMES).includes(activity.detail?.tool),
      'Browser receipt has no named native dynamic-tool item');
    assert.equal(activity.status, 'completed', 'Browser native dynamic-tool item did not complete');
    assert.equal(details.originalProviderId, 'egdesk-browser', 'Browser receipt came from another tool provider');
    assert.equal(details.namespace, null, 'Browser receipt used another namespace');
    assert.ok(Number.isSafeInteger(details.bridgeEpoch) && details.bridgeEpoch >= 0,
      'Browser receipt has no bridge epoch');
    return { itemId: event.itemId, toolName: activity.detail.tool,
      event: event.event, status: details.status || null,
      code: details.code || null, action: details.action || null,
      observationId: details.observationId || null,
      postconditionMatched: details.postconditionMatched ?? null,
      cardId: details.cardId || null, sourceId: details.sourceId || null,
      targetCardEpoch: details.targetCardEpoch || null,
      bridgeEpoch: details.bridgeEpoch,
      externalEffectVerified: details.externalEffectVerified ?? null,
      seq: event.seq };
  });
}

// The rendered human Send click can activate the Chat Card before the model
// runs. Attribute only changes after that original-fetch boundary to the
// Browser model action; keep pan/zoom and Browser keyboard-focus ownership
// stable across both phases.
export function assertBrowserFocusOwnership({ before, preSendFocus, atFetch, after }) {
  assert.ok(Number.isFinite(before?.sampledAtMs)
    && Number.isFinite(preSendFocus?.sampledAtMs)
    && Number.isFinite(atFetch?.sampledAtMs)
    && Number.isFinite(after?.sampledAtMs)
    && before.sampledAtMs <= preSendFocus.sampledAtMs
    && preSendFocus.sampledAtMs <= atFetch.sampledAtMs
    && atFetch.sampledAtMs <= after.sampledAtMs,
  'Browser focus samples do not bracket human Send and model completion');
  assert.equal(preSendFocus.activeEntityId, before.camera?.activeEntityId,
    'Canvas active entity changed before human Send');
  assert.equal(preSendFocus.focusedBrowserCardId, before.focusedCardId,
    'Browser keyboard focus changed before human Send');
  assert.equal(preSendFocus.chatCardEntityId, atFetch.chatCardEntityId,
    'Chat Card identity changed during the original send');
  if (atFetch.activeEntityId !== preSendFocus.activeEntityId) {
    assert.ok(typeof atFetch.chatCardEntityId === 'string' && atFetch.chatCardEntityId,
      'human Send has no identified Chat Card');
    assert.equal(atFetch.activeEntityId, atFetch.chatCardEntityId,
      'human Send activated an entity other than the Chat Card');
  }
  assert.ok(atFetch.focusedBrowserCardId === preSendFocus.focusedBrowserCardId
    || atFetch.focusedBrowserCardId === null,
  'human Send transferred keyboard focus to another Browser Card');
  assert.ok(same(before.camera?.pan, preSendFocus.pan)
    && same(preSendFocus.pan, atFetch.pan)
    && same(atFetch.pan, after.camera?.pan)
    && before.camera?.zoom === preSendFocus.zoom
    && preSendFocus.zoom === atFetch.zoom
    && atFetch.zoom === after.camera?.zoom,
  'Browser QA changed Canvas pan or zoom across the human-send/model boundary');
  assert.equal(after.camera?.activeEntityId, atFetch.activeEntityId,
    'Browser model action changed the human-selected Canvas entity');
  assert.equal(after.focusedCardId, atFetch.focusedBrowserCardId,
    'Browser model action changed human Browser keyboard-focus ownership');
  return { focusOwnershipVerified: true,
    humanSendFocusTransition: atFetch.activeEntityId === preSendFocus.activeEntityId
      ? 'unchanged' : 'chat-card-activated',
    activeEntityAtOriginalFetch: atFetch.activeEntityId,
    focusedBrowserCardAtOriginalFetch: atFetch.focusedBrowserCardId };
}

export function assertBrowserPositiveFlow({ run, events, active, emitted, preSendFocus, cwd,
  selection, fixture, target, control, before, after, expectedPolicyMode = 'fixtureBrowserQa' }) {
  assert.ok(['fixtureBrowserQa', 'browserBounded'].includes(expectedPolicyMode), 'unsupported Browser proof policy');
  assertObservedRunChain({ run, events, active });
  assertBrowserFixtureConfig(fixture?.url, fixture?.marker);
  assert.equal(run.cwdPublic, cwd, 'Browser native run uses another QA cwd');
  const policy = run.executionPolicy;
  assert.equal(policy?.mode, expectedPolicyMode, 'positive Browser run lacks the expected bounded policy');
  assert.equal(policy?.status, 'native-thread-verified', 'Browser native policy was not verified');
  assert.equal(policy?.sandbox, 'readOnly', 'Browser native sandbox is not read-only');
  assert.equal(policy?.networkAccess, false, 'Browser native network is not disabled');
  assert.equal(policy?.approvalPolicy, 'never', 'Browser native approval policy is interactive');
  assert.equal(policy?.externalMcpCatalog, 'empty', 'Browser run exposes external MCP tools');
  assert.ok(Number.isSafeInteger(policy?.inspectedMcpServers) && policy.inspectedMcpServers >= 0,
    'Browser native MCP catalog inspection count is missing');
  if (expectedPolicyMode === 'browserBounded') {
    assert.equal(policy.browserEffects, 'selected-card-observe-click-fill-this-run',
      'ordinary Browser effect scope is not the selected one-run grant');
    assert.deepEqual(emitted?.executionPolicy, { mode: 'browserBounded' },
      'ordinary Browser UI did not emit its exact bounded policy');
    assert.equal(emitted?.requestBodyUnmodified, true,
      'ordinary Browser proof requires an unmodified original fetch body');
  } else {
    assert.equal(policy?.browserEffects, 'attested-local-fixture-only', 'Browser effect scope is not the attested fixture');
  }
  assert.equal(selection?.selectedByUser, true, 'Browser Card was not explicitly selected');
  assert.equal(selection?.permission, 'interact', 'Browser Card lacks an interaction grant');
  assert.equal(selection?.cardId, target.cardId, 'Browser selection targeted another Card');
  assert.equal(selection?.profileId, target.profileId, 'Browser selection targeted another profile');
  assert.equal(selection?.uri, fixture.url, 'Browser selection targeted another URL');
  assert.equal(selection?.accountId, '', 'Browser fixture selection is account-linked');
  assert.equal(emitted?.selectedSources?.length, 1, 'Browser UI send did not select one source');
  assert.equal(emitted.selectedSources[0].sourceId, selection.sourceId,
    'Browser UI send selected another source');
  assert.equal(emitted.selectedSources[0].cardEpoch, selection.cardEpoch,
    'Browser UI send crossed Card epochs');
  assert.equal(emitted.selectedSources[0].uri, fixture.url, 'Browser UI send selected another URL');
  assert.equal(emitted?.contextSnapshotIds?.length, 1,
    'Browser source did not produce one immutable input snapshot');
  const snapshotId = emitted.contextSnapshotIds[0];
  assert.ok(run.context?.captures?.some(capture => capture.sourceId === snapshotId),
    'Browser input snapshot is not bound to this native run');
  assert.ok(events.some(event => event.event === 'context.bound' && event.runId === run.runId
    && event.details?.captures?.some(capture => capture.sourceId === snapshotId)),
  'Browser input snapshot has no matching context-bound SSE event');
  const binding = run.browserBinding;
  assert.equal(binding?.cards?.length, 1, 'native Browser binding is not single-card');
  assert.deepEqual(binding.cards[0], { cardId: selection.cardId, permission: 'interact',
    sourceId: selection.sourceId, cardEpoch: selection.cardEpoch },
  'native Browser binding differs from the selected Card/source');
  const bound = events.find(event => event.event === 'browser.bound' && event.runId === run.runId
    && same(event.details, binding));
  assert.ok(bound, 'native Browser binding SSE receipt is missing');
  assert.ok(!(run.activities || []).some(item => ['commandExecution', 'fileChange', 'mcpToolCall',
    'webSearch', 'collabAgentToolCall'].includes(item.kind)),
    'Browser positive turn used an unrelated native tool');
  const calls = browserToolReceipts(run, events);
  assert.equal(calls.length, 4, 'Browser positive turn must contain observe/click/re-observe/fill only');
  assert.equal((run.activities || []).filter(item => item.kind === 'dynamicToolCall').length, 4,
    'Browser native dynamic-tool item count differs from public receipts');
  assert.ok(calls.every(call => call.event === 'browser.tool.completed'
    && call.cardId === selection.cardId && call.sourceId === selection.sourceId
    && call.targetCardEpoch === selection.cardEpoch && call.externalEffectVerified === false),
  'Browser positive turn contains an unverified, foreign or external-effect tool event');
  assert.ok(calls.every((call, index) => index === 0 || call.seq > calls[index - 1].seq)
    && calls[0].seq > bound.seq, 'Browser tool events are out of native SSE order');
  assert.equal(new Set(calls.map(call => call.itemId)).size, 4, 'Browser call IDs are not unique');
  assert.equal(new Set(calls.map(call => call.bridgeEpoch)).size, 1,
    'Browser positive tool calls crossed bridge epochs');
  assert.deepEqual(calls.map(call => call.toolName), [BROWSER_TOOL_NAMES.observe,
    BROWSER_TOOL_NAMES.click, BROWSER_TOOL_NAMES.observe, BROWSER_TOOL_NAMES.fill],
  'Browser model did not follow observe/click/re-observe/fill');
  assert.equal(calls[0].status, 'observed', 'initial Browser observation was not attested');
  assert.ok(calls[0].observationId && calls[2].observationId
    && calls[0].observationId !== calls[2].observationId,
  'Browser action did not receive a fresh second observation');
  assert.equal(calls[1].status, 'postcondition-observed', 'Browser click postcondition was not observed');
  assert.equal(calls[1].action, 'click', 'Browser action was not a click');
  assert.equal(calls[1].postconditionMatched, true, 'Browser click postcondition did not match');
  assert.equal(calls[2].status, 'observed', 'second Browser observation was not attested');
  assert.equal(calls[3].status, 'postcondition-observed', 'Browser fill postcondition was not observed');
  assert.equal(calls[3].action, 'fill', 'Browser action was not a fill');
  assert.equal(calls[3].postconditionMatched, true, 'Browser fill postcondition did not match');
  const answer = (run.messages || []).filter(item => item.role === 'assistant')
    .map(item => item.text || '').join('\n');
  assert.ok(answer.includes(fixture.marker), 'model answer omitted the unexpected Browser fixture marker');
  assert.equal(before.targetUrl, fixture.url, 'independent pre-turn Browser URL differs from owned fixture');
  assert.equal(after.targetUrl, fixture.url, 'independent post-turn Browser URL differs from owned fixture');
  assert.equal(before.targetProfileId, selection.profileId, 'pre-turn Browser profile differs from selected Card');
  assert.equal(after.targetProfileId, selection.profileId, 'post-turn Browser profile changed');
  assert.equal(before.targetCardEpoch, selection.cardEpoch, 'pre-turn Browser Card epoch differs');
  assert.equal(after.targetCardEpoch, selection.cardEpoch, 'post-turn Browser Card epoch changed');
  assert.equal(before.targetAccountId, '', 'pre-turn Browser fixture is account-linked');
  assert.equal(after.targetAccountId, '', 'post-turn Browser fixture is account-linked');
  assert.ok(typeof before.targetDocumentId === 'string' && before.targetDocumentId,
    'independent pre-turn actor document ID is missing');
  assert.equal(after.targetDocumentId, before.targetDocumentId,
    'Browser action crossed fixture document identities');
  assert.ok(Number.isSafeInteger(before.targetRevision) && Number.isSafeInteger(after.targetRevision)
    && after.targetRevision > before.targetRevision,
  'independent Browser actor revision did not advance with the DOM change');
  assert.ok(same(before.targetViewport, after.targetViewport),
    'Browser actor viewport changed during the bounded interaction');
  assert.ok(before.targetSegments?.includes(fixture.marker) && after.targetSegments?.includes(fixture.marker),
    'exact fixture marker did not persist in independently observed DOM');
  assert.ok(before.targetText.includes('Waiting for QA action')
    && !before.targetText.includes('Changed by QA click')
    && !before.targetText.includes('Newly revealed node')
    && after.targetText.includes('Changed by QA click')
    && after.targetText.includes('Newly revealed node'),
  'independent target DOM did not show the local click change');
  assert.ok(before.targetInteractive?.some(item => item.label === 'Reveal QA details'
    && item.tag.toLowerCase() === 'button'), 'fixture has no observed harmless button');
  assert.ok(before.targetInteractive?.some(item => item.label === 'QA note'
    && item.tag.toLowerCase() === 'input'), 'fixture has no observed harmless text input');
  assert.equal(before.inputValue, '', 'fixture input was not empty before the model action');
  assert.equal(after.inputValue, target.fillValue, 'independent target input value did not change');
  assert.equal(before.controlText, after.controlText, 'control Card DOM changed');
  assert.equal(before.controlInputValue, after.controlInputValue, 'control Card input changed');
  assert.ok(same(before.cards, after.cards),
    'Browser action changed Card inventory');
  const focusProof = assertBrowserFocusOwnership({ before, preSendFocus,
    atFetch: emitted.focusAtOriginalFetch, after });
  return { cardId: selection.cardId, sourceId: selection.sourceId,
    inputSnapshotId: snapshotId, itemIds: calls.map(call => call.itemId),
    publicModelToolReceiptsVerified: true, independentLocalDomVerified: true,
    expectedPolicyMode, requestBodyUnmodified: expectedPolicyMode === 'browserBounded'
      && emitted.requestBodyUnmodified === true,
    ordinaryUiRequestUnmodified: expectedPolicyMode === 'browserBounded'
      && emitted.requestBodyUnmodified === true,
    independentActorDocumentRevisionVerified: true,
    modelActionGuardRevisionPubliclyVerified: false,
    inputFocusedAfter: after.targetInputFocused === true,
    ...focusProof, humanTypingProbeVerified: false,
    negativeGuardsVerified: false, externalEffectVerified: false };
}

export function assertBrowserRenderedAnswer({ run, rendered, threadId, fixture }) {
  assert.equal(run?.status, 'completed', 'rendered Browser answer has no completed native run');
  const candidates = (run.messages || []).filter(message => message.role === 'assistant'
    && message.status === 'complete' && typeof message.text === 'string' && message.text.trim());
  const final = candidates.filter(message => message.phase === 'final_answer').at(-1) || candidates.at(-1);
  assert.ok(typeof final?.id === 'string' && final.id, 'completed native Browser answer has no item ID');
  assert.ok(final.text.includes(fixture.marker), 'completed native Browser answer omitted the fixture marker');
  assert.equal(rendered?.activeThreadId, threadId, 'rendered Browser answer is in another Chat thread');
  assert.equal(rendered?.conversationId, run.conversationId, 'rendered Browser answer is in another conversation');
  const row = rendered.rows?.find(item => item.role === 'assistant'
    && item.runId === run.runId && item.nativeItemId === final.id);
  assert.ok(row, 'native final Browser answer has no run-bound rendered Chat row');
  assert.equal(row.status, 'complete', 'rendered Browser answer is still incomplete');
  assert.equal(row.stateText, final.text, 'rendered Browser answer state differs from the native final item');
  assert.equal(row.visible, true, 'native Browser answer is not visible in the rendered Chat');
  assert.ok(typeof row.text === 'string' && row.text.includes(fixture.marker),
    'visible Browser answer omitted the fixture marker');
  return { renderedFinalAnswerVerified: true, finalNativeItemId: final.id,
    renderedMessageId: row.messageId, renderedThreadId: threadId,
    renderedConversationId: run.conversationId };
}

async function renderedBrowserAnswer(harness, thread, run, fixture, deadlineMs) {
  const sample = await waitUntil(async () => {
    assertBeforeDeadline(deadlineMs);
    return chrome(harness, ({ threadId, runId }) => {
      const codex = window.__egdesk?.state?.codex;
      const current = codex?.threads?.find(item => item.id === threadId);
      const log = [...document.querySelectorAll('.egd-codex-messages')]
        .find(node => node.dataset.threadId === threadId);
      const intersects = (a, b) => a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0
        && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const viewport = { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
        width: window.innerWidth, height: window.innerHeight };
      const rows = log ? [...log.querySelectorAll('[data-testid="chat-message"][data-role="assistant"]')]
        .filter(row => row.dataset.runId === runId).map(row => {
          const local = current?.messages?.find(message => message.id === row.dataset.messageId);
          const content = row.querySelector('.egd-codex-bubble-content');
          const rowRect = row.getBoundingClientRect(), logRect = log.getBoundingClientRect();
          const style = getComputedStyle(row);
          return { messageId: row.dataset.messageId, runId: row.dataset.runId,
            nativeItemId: local?.providerItemId || local?.messageId || local?.id || null,
            role: row.dataset.role, status: local?.status || null,
            stateText: local?.content ?? local?.text ?? null,
            text: content?.innerText || '',
            visible: row.isConnected && !row.hidden && style.display !== 'none'
              && style.visibility !== 'hidden' && intersects(rowRect, logRect) && intersects(rowRect, viewport) };
        }) : [];
      return { activeThreadId: codex?.activeThreadId || null,
        conversationId: current?.conversationId || null, rows };
    }, { threadId: thread.id, runId: run.runId });
  }, value => {
    try { assertBrowserRenderedAnswer({ run, rendered: value, threadId: thread.id, fixture }); return true; }
    catch { return false; }
  }, { timeoutMs: 15000, intervalMs: 200 });
  return assertBrowserRenderedAnswer({ run, rendered: sample, threadId: thread.id, fixture });
}

// Native-model negative-guard receipts are not wired. The separately selected
// browser-negative scenario exercises synthetic B runs against the owned live
// UI/actor; it cannot satisfy assertBrowserNegativeGuards or native coverage.

async function reflectedOrdinaryRequest(harness, thread, cwd, sourceIds = [], { allowExisting = false } = {}) {
  return chrome(harness, ({ threadId, cwd, sourceIds, allowExisting }) => {
    const api = window.__egdesk;
    const thread = api.state.codex.threads.find(item => item.id === threadId);
    if (!thread || (!allowExisting && thread.conversationId) || thread.profileEnabled === true) {
      throw new Error('QA thread is not the requested ordinary Chat');
    }
    thread.cwd = cwd; // Test-scoped cwd metadata; sending still uses the rendered Chat composer.
    const module = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
    const runtime = api.codexBridge.threadRuntimeConfig(threadId);
    runtime.contextSnapshotIds = sourceIds;
    runtime.contextCapabilities = sourceIds.length ? { read: true, reader: true, publishBriefing: true } : null;
    const request = module.buildChatRequest(thread, 'reflection only; not sent', 'qa-not-sent', runtime);
    return { cwd: request.cwd, profileEnabled: request.profileEnabled,
      conversationId: request.conversationId || null,
      contextSnapshotIds: request.contextSnapshotIds || [],
      executionPolicy: request.executionPolicy || null,
      qaCommandNonce: request.qaCommandNonce || null,
      qaOutputMarkers: request.qaOutputMarkers || [],
      browserTransportId: request.browserTransportId || null,
      selectedSources: (request.selectedSources || []).map(source => ({ kind: source.kind,
        sourceId: source.id || null,
        cardId: source.sourceRef?.viewId || null, profileId: source.sourceRef?.profileId || null,
        uri: source.sourceRef?.uri || null,
        accountId: source.sourceRef?.accountId || '',
        permission: source.browserToolPermission || null, selectedByUser: source.selectedByUser === true,
        cardEpoch: source.browserToolIdentity?.cardEpoch || null,
        hasOneTimeToken: typeof source.browserToolSelection?.token === 'string'
          && !!source.browserToolSelection.token,
        tokenThreadId: source.browserToolSelection?.threadId || null })),
      personaFields: ['agentProfile', 'systemPrompt', 'toolMode'].filter(field => Object.hasOwn(request, field)) };
  }, { threadId: thread.id, cwd, sourceIds, allowExisting });
}

// Self-contained for chrome() serialization and a fake-window unit check of
// original fetch argument identity. This exports QA code, not a product API.
export function installQaSendWitness(expected) {
    if (window.__egdeskQaSendInterceptor) throw new Error('QA Chat fetch interceptor is already installed');
    const route = 'http://127.0.0.1:39218/chat/send';
    const original = window.fetch;
    if (typeof original !== 'function') throw new Error('Original Chat fetch is unavailable');
    const state = { original, wrapper: null, used: false, snapshot: null };
    const wrapper = function(input, init) {
      const url = typeof input === 'string' ? input : input?.url;
      if (url !== route) return original.call(window, input, init);
      if (state.used) throw new Error('QA interceptor refuses a second Chat send');
      if (expected.qaOutputMarkers.length && (expected.qaOutputMarkers.length !== 2
          || new Set(expected.qaOutputMarkers).size !== 2
          || expected.qaOutputMarkers.some(marker => !/^[A-Za-z0-9_-]{20,80}$/.test(marker)))) {
        throw new Error('Native QA requires two distinct bounded output markers before original fetch');
      }
      if (init?.method !== 'POST' || typeof init.body !== 'string') throw new Error('QA Chat send has an unknown request shape');
      const originalBody = init.body;
      const unmodifiedBrowserWitness = expected.policyMode === 'browserBounded';
      let body;
      try { body = JSON.parse(init.body); } catch { throw new Error('QA Chat send body is not JSON'); }
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
          body.clientThreadId !== expected.clientThreadId || body.cwd !== expected.cwd ||
          body.message !== expected.message || body.profileEnabled !== false ||
          (body.conversationId || null) !== expected.conversationId ||
          typeof body.requestId !== 'string' || !body.requestId ||
          ['agentProfile', 'systemPrompt', 'toolMode'].some(key => Object.hasOwn(body, key))) {
        throw new Error('QA Chat request differs from the scoped ordinary composer send');
      }
      const localThread = window.__egdesk?.state?.codex?.threads?.find(item => item.id === expected.localThreadId);
      if (!localThread || window.__egdesk.state.codex.activeThreadId !== expected.localThreadId) {
        throw new Error('QA Chat local thread changed before the original fetch');
      }
      const modelFacingBody = { ...body };
      delete modelFacingBody.qaOutputMarkers; // Backend-only witness list, never model admission.
      delete modelFacingBody.qaCommandNonce;
      const modelAdmission = JSON.stringify({ body: modelFacingBody,
        title: localThread.title, inputSources: localThread.inputSources || [],
        briefingInputs: localThread.briefingInputs || [] });
      if (expected.hiddenMarker && modelAdmission.includes(expected.hiddenMarker)) {
        throw new Error('QA file-content marker leaked into model-facing admission');
      }
      if (Array.isArray(expected.sourceIds)
          && JSON.stringify(body.contextSnapshotIds || []) !== JSON.stringify(expected.sourceIds)) {
        throw new Error('QA Chat source selection changed before send');
      }
      const selected = body.selectedSources || [];
      if (!Array.isArray(selected) || selected.length !== (expected.selectedCardId ? 1 : 0)) {
        throw new Error('QA Chat Browser selection is missing or broader than expected');
      }
      if (expected.selectedCardId) {
        if (!Number.isFinite(expected.browserTransportSampledAtMs)
            || expected.browserTransportSampledAtMs > Date.now()) {
          throw new Error('QA root SSE Browser transport is stale before original fetch');
        }
        const currentRoot = window.__egdesk?.browserAgentTools?.rootSseReady?.();
        const rootCheckedAtMs = Date.now();
        if (currentRoot?.sourceReady !== true || currentRoot.stable !== true
            || currentRoot.eventSourceReadyState !== 1
            || !Number.isFinite(currentRoot.sampledAtMs)
            || currentRoot.sampledAtMs > rootCheckedAtMs
            || rootCheckedAtMs - currentRoot.sampledAtMs > 5000
            || currentRoot.browserTransportId !== expected.browserTransportId) {
          throw new Error('QA root SSE Browser transport changed before original fetch');
        }
        state.rootSseAtFetch = { stable: currentRoot.stable,
          readyState: currentRoot.eventSourceReadyState,
          sampledAtMs: currentRoot.sampledAtMs, checkedAtMs: rootCheckedAtMs };
        const source = selected[0];
        if (source.kind !== 'browser' || source.id !== expected.selectedSourceId ||
            source.sourceRef?.viewId !== expected.selectedCardId ||
            source.sourceRef?.profileId !== expected.selectedProfileId ||
            source.sourceRef?.uri !== expected.browserFixtureUrl ||
            source.sourceRef?.accountId !== '' ||
            source.browserToolIdentity?.cardEpoch !== expected.selectedCardEpoch ||
            source.browserToolPermission !== 'interact' || source.selectedByUser !== true ||
            source.browserToolSelection?.threadId !== expected.clientThreadId ||
            typeof source.browserToolSelection?.token !== 'string' || !source.browserToolSelection.token ||
            body.browserTransportId !== expected.browserTransportId) {
          throw new Error('QA Chat Browser source token/transport is not bound to this Card and thread');
        }
        const ui = window.__egdesk.state;
        const activeElement = document.activeElement;
        state.focusAtOriginalFetch = {
          sampledAtMs: Date.now(),
          activeEntityId: ui.activeEntityId || null,
          chatCardEntityId: ui.codex?.chatCardEntityId || null,
          focusedBrowserCardId: activeElement?.closest?.('.egd-browser-card')?.id || null,
          focusedChatCardId: activeElement?.closest?.('.egd-chat-card')?.id || null,
          activeElementId: activeElement?.id || null,
          activeElementTag: activeElement?.tagName?.toLowerCase?.() || null,
          pan: { ...ui.panTarget }, zoom: ui.zoomTarget,
        };
      }
      if (body.executionPolicy && body.executionPolicy.mode !== expected.policyMode) {
        throw new Error('QA Chat request has a conflicting execution policy');
      }
      if (body.qaCommandNonce != null) {
        throw new Error('QA Chat request used the legacy single-nonce field');
      }
      if (body.qaOutputMarkers != null
          && JSON.stringify(body.qaOutputMarkers) !== JSON.stringify(expected.qaOutputMarkers)) {
        throw new Error('QA Chat request has conflicting output markers');
      }
      if (unmodifiedBrowserWitness) {
        if (!expected.selectedCardId || expected.qaOutputMarkers.length
            || Object.hasOwn(body, 'qaCommandNonce') || Object.hasOwn(body, 'qaOutputMarkers')) {
          throw new Error('Ordinary Browser witness requires one selected Card and no QA receipt fields');
        }
        if (!body.executionPolicy || Object.keys(body.executionPolicy).length !== 1
            || body.executionPolicy.mode !== 'browserBounded') {
          throw new Error('Ordinary Browser UI must emit browserBounded before original fetch; witness will not inject it');
        }
        if (init.body !== originalBody) throw new Error('Ordinary Browser request body changed during observation');
      } else {
        // Native/source QA retains the existing explicit bounded-policy
        // instrumentation. It must not be counted as an ordinary UI witness.
        body.executionPolicy = { mode: expected.policyMode };
        if (expected.qaOutputMarkers.length) body.qaOutputMarkers = [...expected.qaOutputMarkers];
      }
      const snapshot = { route, forwardedToOriginalFetch: true, requestId: body.requestId,
        requestBodyUnmodified: unmodifiedBrowserWitness && init.body === originalBody,
        clientThreadId: body.clientThreadId, conversationId: body.conversationId || null,
        cwd: body.cwd, profileEnabled: body.profileEnabled, personaFields: [],
        messageMatched: body.message === expected.message,
        hiddenMarkerAbsentFromModelAdmission: !expected.hiddenMarker
          || !modelAdmission.includes(expected.hiddenMarker),
        contextSnapshotIds: body.contextSnapshotIds || [], executionPolicy: body.executionPolicy,
        qaCommandNonce: body.qaCommandNonce || null,
        qaOutputMarkers: body.qaOutputMarkers || [],
        browserTransportId: body.browserTransportId || null,
        rootSseStable: state.rootSseAtFetch?.stable ?? null,
        rootSseReadyState: state.rootSseAtFetch?.readyState ?? null,
        rootSseSampledAtMs: state.rootSseAtFetch?.sampledAtMs ?? null,
        rootSseCheckedAtMs: state.rootSseAtFetch?.checkedAtMs ?? null,
        focusAtOriginalFetch: state.focusAtOriginalFetch || null,
        selectedSources: selected.map(source => ({ kind: source.kind,
          sourceId: source.id || null,
          cardId: source.sourceRef?.viewId || null, profileId: source.sourceRef?.profileId || null,
          uri: source.sourceRef?.uri || null,
          accountId: source.sourceRef?.accountId || '',
          permission: source.browserToolPermission || null, selectedByUser: source.selectedByUser === true,
          cardEpoch: source.browserToolIdentity?.cardEpoch || null,
          hasOneTimeToken: typeof source.browserToolSelection?.token === 'string'
            && !!source.browserToolSelection.token,
          tokenThreadId: source.browserToolSelection?.threadId || null })) };
      state.used = true;
      state.snapshot = snapshot;
      if (unmodifiedBrowserWitness) return original.call(window, input, init);
      return original.call(window, input, { ...init, body: JSON.stringify(body) });
    };
    state.wrapper = wrapper;
    window.__egdeskQaSendInterceptor = state;
    window.fetch = wrapper;
    if (window.fetch !== wrapper) {
      delete window.__egdeskQaSendInterceptor;
      throw new Error('QA Chat fetch could not be instrumented');
    }
    return true;
}

async function installQaSendInterceptor(harness, expected) {
  return chrome(harness, installQaSendWitness, expected);
}

const observedQaSend = harness => chrome(harness, () => window.__egdeskQaSendInterceptor?.snapshot || null);

async function removeQaSendInterceptor(harness) {
  return chrome(harness, () => {
    const state = window.__egdeskQaSendInterceptor;
    if (!state) return null;
    if (window.fetch !== state.wrapper) throw new Error('QA Chat fetch changed after instrumentation');
    window.fetch = state.original;
    delete window.__egdeskQaSendInterceptor;
    return state.snapshot;
  });
}

async function observedChatProxies(harness) {
  return chrome(harness, () => ({
    activeCardId: window.__egdesk?.state?.codex?.chatCardEntityId || null,
    proxies: [...document.querySelectorAll('.egd-chat-card .egd-semantic-proxy[data-kind="chat"]')]
      .map(proxy => {
        const rect = proxy.getBoundingClientRect();
        const style = getComputedStyle(proxy);
        return { cardId: proxy.closest('.egd-chat-card')?.id || null,
          visible: !proxy.hidden && rect.width > 0 && rect.height > 0
            && style.display !== 'none' && style.visibility !== 'hidden' };
      }),
  }));
}

async function ensureVisibleChatComposer(harness, deadlineMs) {
  assertBeforeDeadline(deadlineMs);
  // A nonzero rectangle does not mean a Card is clickable: Browser fixtures
  // may overlap Chat. Raise the owned Chat Card before native UI interaction.
  // This is setup only, before the model's focus-preservation baseline.
  await chrome(harness, () => {
    const api = window.__egdesk;
    const card = document.getElementById(api?.state?.codex?.chatCardEntityId);
    if (card?.classList.contains('egd-chat-card')) api.cardRuntime.focusCard(card);
    return true;
  });
  const visibleInput = async () => (await harness.inspect('.egd-codex-input'))
    .some(item => item.visible);
  if (await visibleInput()) return;
  let observed = await observedChatProxies(harness);
  let cardId = chooseChatProxyTarget(observed.proxies, observed.activeCardId);
  if (!cardId) {
    const shellVisible = (await harness.inspect('.egd-codex-chat-shell')).some(item => item.visible);
    if (!shellVisible) {
      assertBeforeDeadline(deadlineMs);
      await harness.click('.egd-dock-btn[data-id="chat"]');
    }
    const state = await waitUntil(async () => {
      if (await visibleInput()) return { inputVisible: true };
      const next = await observedChatProxies(harness);
      return { cardId: chooseChatProxyTarget(next.proxies, next.activeCardId) };
    }, item => item.inputVisible || item.cardId, { timeoutMs: 10000, intervalMs: 150 });
    if (state.inputVisible) return;
    cardId = state.cardId;
  }
  // Native MCP click on the actual rendered proxy; camera focus is async.
  assertBeforeDeadline(deadlineMs);
  await harness.click(`${selectorForId(cardId)} .egd-semantic-proxy[data-kind="chat"]`);
  await waitUntil(visibleInput, Boolean, { timeoutMs: 15000, intervalMs: 150 });
}

async function newQaThreadInVisibleChat(harness, title, deadlineMs) {
  assertTurnTimeBudget(deadlineMs);
  await ensureVisibleChatComposer(harness, deadlineMs);
  const thread = await newQaThread(harness, title);
  await ensureVisibleChatComposer(harness, deadlineMs);
  return thread;
}

async function newSourceQaThreadWithReceipts(harness, title, deadlineMs, result) {
  assertTurnTimeBudget(deadlineMs);
  result.sourceStage = 'chat-focus-requested';
  await ensureVisibleChatComposer(harness, deadlineMs);
  result.sourceStage = 'chat-visible';
  const prior = await chatIdentity(harness);
  result.sourcePriorThreadId = prior.threadId;
  if ((await harness.inspect('.egd-codex-conversation-back')).some(node => node.visible)) {
    result.sourceStage = 'back-click-requested';
    result.sourceUiAction = { kind: 'back', status: 'unconfirmed', priorThreadId: prior.threadId };
    await harness.click('.egd-codex-conversation-back');
    result.sourceUiAction.status = 'acknowledged';
    result.sourceStage = 'back-click-acknowledged';
  }
  result.sourceStage = 'new-room-click-requested';
  result.sourceUiAction = { kind: 'new-room', status: 'unconfirmed', priorThreadId: prior.threadId };
  await harness.click('.egd-codex-thread-home-new');
  result.sourceUiAction.status = 'acknowledged';
  result.sourceStage = 'new-room-click-acknowledged';
  await waitUntil(() => harness.inspect('[data-testid="chat-composer"]'),
    nodes => nodes.some(node => node.visible), { timeoutMs: 15000 });
  result.sourceStage = 'composer-visible';
  result.sourceStage = 'metadata-requested';
  const thread = await chrome(harness, title => {
    const codex = window.__egdesk.state.codex;
    const selected = codex.threads.find(item => item.id === codex.activeThreadId);
    if (!selected || selected.conversationId || selected.messages.length || selected.profileEnabled === true) {
      throw new Error('New source QA thread is not an empty ordinary Codex conversation');
    }
    selected.title = title;
    const module = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
    const reflected = module.buildChatRequest(selected, 'QA identity reflection; not sent',
      'qa-reflection-not-sent', window.__egdesk.codexBridge.threadRuntimeConfig(selected.id));
    return { id: selected.id, title, wireClientThreadId: reflected.clientThreadId };
  }, title);
  result.sourceStage = 'metadata-bound';
  result.sourceThreadId = thread.id;
  await ensureVisibleChatComposer(harness, deadlineMs);
  result.sourceStage = 'thread-ready';
  return thread;
}

async function resumeConfirmedEmptySourceThread(harness, expectedId, title, deadlineMs, result) {
  assertTurnTimeBudget(deadlineMs);
  result.sourceStage = 'resume-validation-requested';
  const observed = await chrome(harness, () => {
    const api = window.__egdesk;
    const codex = api.state.codex;
    const thread = codex.threads.find(item => item.id === codex.activeThreadId);
    const module = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
    const visible = node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return !node.hidden && rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const inputs = [...document.querySelectorAll('.egd-codex-input')].filter(visible);
    const composers = [...document.querySelectorAll('[data-testid="chat-composer"]')].filter(visible);
    return { activeThreadId: codex.activeThreadId,
      thread: thread ? { id: thread.id, title: thread.title,
        conversationId: thread.conversationId || null,
        localConversationId: thread.localConversationId || null,
        profileEnabled: thread.profileEnabled === true,
        bindingState: thread.bindingState || null,
        bindingAccountKey: thread.bindingAccountKey || null,
        nativeBindingHeld: module.nativeBindingHeld(thread),
        messagesCount: thread.messages?.length ?? -1,
        inputSourcesCount: thread.inputSources?.length || 0,
        briefingInputsCount: thread.briefingInputs?.length || 0,
        preparingInput: thread.preparingInput === true,
        resuming: thread.resuming === true, sendError: thread.sendError || null } : null,
      nativeRunCount: (api.codexBridge.runState?.(thread?.id) || []).length,
      visibleInputCount: inputs.length, composerVisible: composers.length === 1,
      inputThreadId: inputs[0]?.dataset?.threadId || null,
      inputValue: inputs[0]?.value ?? null,
      draftText: thread ? (codex.threadDrafts?.[thread.id] ?? codex.draft ?? '') : null,
      wireClientThreadId: module.clientThreadBinding(thread) };
  });
  assertResumeEmptyThreadState(observed, expectedId);
  result.sourceStage = 'resume-validation-receipt';
  result.sourceResumeReceipt = { threadId: expectedId,
    priorTitle: observed.thread.title, wireClientThreadId: observed.wireClientThreadId,
    emptyOrdinaryRoomVerified: true };
  result.sourceStage = 'resume-metadata-requested';
  const bound = await chrome(harness, ({ expectedId, priorTitle, wireClientThreadId, title }) => {
    const api = window.__egdesk;
    const codex = api.state.codex;
    const thread = codex.threads.find(item => item.id === expectedId);
    const module = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
    const input = [...document.querySelectorAll('.egd-codex-input')].find(node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && style.visibility !== 'hidden';
    });
    if (codex.activeThreadId !== expectedId || !thread || thread.title !== priorTitle ||
        thread.conversationId || thread.localConversationId || thread.profileEnabled === true ||
        module.nativeBindingHeld(thread) || thread.bindingAccountKey ||
        ![null, 'fresh'].includes(thread.bindingState || null) ||
        thread.messages?.length || thread.inputSources?.length || thread.briefingInputs?.length ||
        thread.preparingInput || thread.resuming || thread.sendError ||
        (api.codexBridge.runState?.(expectedId) || []).length ||
        !input || input.dataset.threadId !== expectedId || input.value !== '' ||
        (codex.threadDrafts?.[expectedId] ?? codex.draft ?? '') !== '' ||
        module.clientThreadBinding(thread) !== wireClientThreadId) {
      throw new Error('Confirmed empty source QA room changed before metadata binding');
    }
    thread.title = title;
    const reflected = module.buildChatRequest(thread, 'QA identity reflection; not sent',
      'qa-reflection-not-sent', api.codexBridge.threadRuntimeConfig(thread.id));
    if (reflected.clientThreadId !== wireClientThreadId) {
      throw new Error('Source QA room client binding changed during metadata reflection');
    }
    return { id: thread.id, title, wireClientThreadId: reflected.clientThreadId };
  }, { expectedId, priorTitle: observed.thread.title,
    wireClientThreadId: observed.wireClientThreadId, title });
  result.sourceStage = 'thread-ready';
  result.sourceThreadId = bound.id;
  return bound;
}

async function resumePreparedSourceDraft(harness, options, qaCwd, prompt, deadlineMs, result) {
  assertTurnTimeBudget(deadlineMs);
  result.sourceStage = 'prepared-draft-validation-requested';
  const observed = await chrome(harness, () => {
    const api = window.__egdesk;
    const codex = api.state.codex;
    const thread = codex.threads.find(item => item.id === codex.activeThreadId);
    const module = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
    const visible = node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return !node.hidden && rect.width > 0 && rect.height > 0
        && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const inputs = [...document.querySelectorAll('.egd-codex-input')].filter(visible);
    const composers = [...document.querySelectorAll('[data-testid="chat-composer"]')].filter(visible);
    const buttons = [...document.querySelectorAll('.egd-codex-send')].filter(visible);
    const button = buttons.length === 1 ? buttons[0] : null;
    const rect = button?.getBoundingClientRect();
    const hit = rect && document.elementFromPoint(rect.left + rect.width / 2,
      rect.top + rect.height / 2);
    return { activeThreadId: codex.activeThreadId,
      thread: thread ? { id: thread.id, title: thread.title, cwd: thread.cwd || null,
        conversationId: thread.conversationId || null,
        localConversationId: thread.localConversationId || null,
        profileEnabled: thread.profileEnabled === true,
        bindingState: thread.bindingState || null,
        bindingAccountKey: thread.bindingAccountKey || null,
        nativeBindingHeld: module.nativeBindingHeld(thread),
        messagesCount: thread.messages?.length ?? -1,
        inputSourcesCount: thread.inputSources?.length || 0,
        briefingInputsCount: thread.briefingInputs?.length || 0,
        preparingInput: thread.preparingInput === true,
        resuming: thread.resuming === true, sendError: thread.sendError || null } : null,
      reference: thread?.briefingInputs?.[0] || null,
      nativeRunCount: (api.codexBridge.runState?.(thread?.id) || []).length,
      visibleInputCount: inputs.length, composerVisible: composers.length === 1,
      inputThreadId: inputs[0]?.dataset?.threadId || null,
      inputValue: inputs[0]?.value ?? null,
      draftText: thread ? (codex.threadDrafts?.[thread.id] ?? codex.draft ?? '') : null,
      sendButtonVisible: !!button, sendButtonEnabled: !!button && !button.disabled,
      sendButtonUnobscured: !!button && !!hit && (hit === button || button.contains(hit)),
      wireClientThreadId: module.clientThreadBinding(thread) };
  });
  const sourceFile = path.join(qaCwd, 'source-read.txt');
  const info = fs.lstatSync(sourceFile);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.uid === process.getuid()
    && (info.mode & 0o077) === 0
    && fs.realpathSync.native(sourceFile) === sourceFile,
  'prepared live QA source is not the owned regular file');
  const liveText = fs.readFileSync(sourceFile, 'utf8');
  const stored = await storedSource(harness, { id: options.threadId }, observed.reference);
  const proof = assertPreparedSourceResumeEvidence({ observed, expected: options,
    stored, originalHash: options.originalHash, liveText, sourceFile, prompt });
  result.sourceStage = 'prepared-draft-validation-receipt';
  result.sourceResumeReceipt = { threadId: options.threadId,
    wireClientThreadId: observed.wireClientThreadId, sourceId: options.sourceId,
    originalHash: options.originalHash, currentHash: proof.currentHash,
    existingDraftAndCaptureVerified: true };
  return { thread: { id: options.threadId, title: observed.thread.title,
    wireClientThreadId: observed.wireClientThreadId }, ...proof };
}

async function clickPreparedSourceSendOnce(harness, thread, prompt, sourceId, result) {
  const ready = await chrome(harness, ({ threadId, clientThreadId, prompt, sourceId }) => {
    const api = window.__egdesk;
    const codex = api.state.codex;
    const thread = codex.threads.find(item => item.id === threadId);
    const module = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
    const input = [...document.querySelectorAll('.egd-codex-input')].find(node => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none'
        && style.visibility !== 'hidden';
    });
    const button = document.querySelector('.egd-codex-send');
    const rect = button?.getBoundingClientRect();
    const hit = rect && document.elementFromPoint(rect.left + rect.width / 2,
      rect.top + rect.height / 2);
    return codex.activeThreadId === threadId && thread?.conversationId == null
      && thread?.messages?.length === 0 && thread?.inputSources?.length === 0
      && thread?.briefingInputs?.length === 1
      && thread.briefingInputs[0].sourceId === sourceId
      && !thread.preparingInput && !thread.resuming && !thread.sendError
      && !module.nativeBindingHeld(thread)
      && module.clientThreadBinding(thread) === clientThreadId
      && input?.dataset?.threadId === threadId && input.value === prompt
      && codex.threadDrafts?.[threadId] === prompt
      && !!button && !button.disabled && !!hit && (hit === button || button.contains(hit));
  }, { threadId: thread.id, clientThreadId: thread.wireClientThreadId, prompt, sourceId });
  assert.equal(ready, true, 'prepared source draft changed or Send is obscured before click');
  result.sourceStage = 'prepared-send-click-requested';
  result.sourceUiAction = { kind: 'send-prepared-source', status: 'unconfirmed', threadId: thread.id,
    sourceId };
  await harness.click('.egd-codex-send');
  result.sourceUiAction.status = 'acknowledged';
  result.sourceStage = 'prepared-send-click-acknowledged';
}

async function browserFocusSnapshot(harness) {
  return chrome(harness, () => {
    const ui = window.__egdesk.state;
    const activeElement = document.activeElement;
    return { sampledAtMs: Date.now(),
      activeEntityId: ui.activeEntityId || null,
      chatCardEntityId: ui.codex?.chatCardEntityId || null,
      focusedBrowserCardId: activeElement?.closest?.('.egd-browser-card')?.id || null,
      focusedChatCardId: activeElement?.closest?.('.egd-chat-card')?.id || null,
      activeElementId: activeElement?.id || null,
      activeElementTag: activeElement?.tagName?.toLowerCase?.() || null,
      pan: { ...ui.panTarget }, zoom: ui.zoomTarget };
  });
}

async function completedUiRun(harness, thread, prompt, deadlineMs, {
  cwd, sourceIds = [], qaOutputMarkers = [], policyMode = 'readOnlyQa',
  browserSelection = null, browserRootReady = null, browserFixtureUrl = null,
  conversationId = null, preparedSource = null, hiddenMarker = null,
} = {}) {
  assertTurnTimeBudget(deadlineMs);
  await ensureVisibleChatComposer(harness, deadlineMs);
  assert.equal((await chatIdentity(harness)).threadId, thread.id,
    'rendered Chat focus changed the selected QA thread before send');
  await installQaSendInterceptor(harness, { clientThreadId: thread.wireClientThreadId,
    localThreadId: thread.id,
    cwd, message: prompt, policyMode, qaOutputMarkers, sourceIds,
    hiddenMarker: hiddenMarker || qaOutputMarkers[0] || null,
    selectedCardId: browserSelection?.cardId || null,
    selectedSourceId: browserSelection?.sourceId || null,
    selectedProfileId: browserSelection?.profileId || null,
    selectedCardEpoch: browserSelection?.cardEpoch || null,
    browserFixtureUrl,
    browserTransportId: browserRootReady?.browserTransportId || null,
    browserTransportSampledAtMs: browserRootReady?.sampledAtMs ?? null,
    conversationId });
  let observation;
  let active = null;
  let emitted = null;
  let preSendFocus = null;
  try {
    observation = await observeChatEvents(thread.wireClientThreadId);
    assertTurnTimeBudget(deadlineMs);
    if (browserSelection) preSendFocus = await browserFocusSnapshot(harness);
    if (preparedSource) await clickPreparedSourceSendOnce(harness, thread, prompt,
      preparedSource.sourceId, preparedSource.result);
    else await sendFromComposer(harness, prompt);
    emitted = await waitUntil(() => observedQaSend(harness), Boolean,
      { timeoutMs: 10000, intervalMs: 100 });
    if (browserSelection) {
      assertBrowserUiRequest(emitted, { cwd,
        clientThreadId: thread.wireClientThreadId, conversationId, selection: browserSelection,
        expectedPolicyMode: policyMode });
      assertFreshBrowserRootSse({ ready: browserRootReady, emitted });
    }
    else assertUiQaRequest(emitted, { cwd, clientThreadId: thread.wireClientThreadId,
      conversationId, sourceIds, qaOutputMarkers });
    const started = await waitUntil(async () => {
      assertBeforeDeadline(deadlineMs);
      if (observation.failure) throw observation.failure;
      if (observation.events.some(event => event.event === 'approval.required')) throw new Error('approval required; no reply sent');
      const event = observation.events.find(item => item.event === 'run.started');
      if (!event) {
        const ui = await chatIdentity(harness);
        if (ui.sendError) throw new Error(`rendered Chat rejected the QA send: ${ui.sendError}`);
      }
      return event;
    }, Boolean, { timeoutMs: 120000 });
    let state = await waitUntil(async () => {
      if (Date.now() >= deadlineMs) throw new Error(`Lane C deadline reached during ${started.conversationId}/${started.runId}; Main must inspect/stop the native run`);
      if (observation.failure) throw observation.failure;
      if (observation.events.some(event => event.event === 'approval.required')) throw new Error('approval required; no reply sent');
      const snapshot = await loopbackJson(`/chat/state?conversationId=${encodeURIComponent(started.conversationId)}`);
      const run = snapshot.runs?.find(item => item.runId === started.runId);
      if (!active && run?.status === 'inProgress' && run.executionPolicy?.status === 'native-thread-verified') {
        active = { snapshot: { streamId: snapshot.streamId, seq: snapshot.seq }, run };
      }
      if (run?.pendingApprovals?.some(item => item.status === 'pending')) throw new Error('approval required; no reply sent');
      if (run && ['failed', 'interrupted'].includes(run.status)) throw new Error(`native run ended ${run.status}`);
      return { snapshot, run };
    }, value => value.run?.status === 'completed', { timeoutMs: 180000, intervalMs: 500 });
    await waitUntil(() => {
      assertBeforeDeadline(deadlineMs);
      return observation.events.find(item => item.event === 'run.completed'
        && item.runId === started.runId && item.details?.status === 'completed');
    },
    Boolean, { timeoutMs: 10000, intervalMs: 100 });
    if (qaOutputMarkers.length) {
      state = await waitUntil(async () => {
        if (Date.now() >= deadlineMs) throw new Error('Lane C deadline reached while waiting for native QA output-marker receipts');
        const snapshot = await loopbackJson(`/chat/state?conversationId=${encodeURIComponent(started.conversationId)}`);
        const run = snapshot.runs?.find(item => item.runId === started.runId);
        const receipts = run?.qaCommandReceipts || [];
        const events = observation.events.filter(item => item.event === 'qa.command.receipt'
          && item.runId === started.runId);
        return { snapshot, run, receipts, events };
      }, value => qaOutputMarkers.every(marker => value.receipts.some(item => item.markerLines?.includes(marker))
        && value.events.some(item => item.details?.markerLines?.includes(marker))),
      { timeoutMs: 30000, intervalMs: 200 });
    }
    assert.equal(state.snapshot.truncated, false, 'native snapshot is truncated');
    assertRunIdentity(state.run, observation.events, thread.wireClientThreadId);
    assert.equal(state.run.requestId, emitted.requestId,
      'backend native run does not match the original composer fetch');
    return { run: state.run, events: [...observation.events], active, emitted, preSendFocus };
  } finally {
    try { await observation?.close(); }
    finally { await removeQaSendInterceptor(harness); }
  }
}

async function captureImmutableSource(harness, thread, sourceFile, deadlineMs, result) {
  assertBeforeDeadline(deadlineMs);
  result.sourceStage = 'capture-requested';
  const reference = await chrome(harness, async ({ threadId, file }) => {
    const bridge = window.__egdesk.codexBridge;
    const source = { id: `qa-source-${Math.random().toString(36).slice(2)}`, kind: 'file',
      label: 'Public QA source', sourceRef: { path: file } };
    const references = await bridge.captureInputs(threadId, [source]);
    const reference = references?.[0];
    if (!reference?.sourceId || reference.snapshotId !== reference.sourceId) throw new Error('production capture did not return bound source ID');
    return reference;
  }, { threadId: thread.id, file: sourceFile });
  result.sourceStage = 'capture-receipt';
  result.sourceCapture = { sourceId: reference.sourceId, hash: reference.hash };
  result.sourceStage = 'attach-requested';
  await chrome(harness, ({ threadId, reference }) => {
    const bridge = window.__egdesk.codexBridge;
    // This is the existing immutable-reference attachment path. It does not
    // invoke a model, replace the transport, or mutate the source capture.
    bridge.attachBriefingComment(threadId, { text: '', contextSnapshotIds: [reference.sourceId] }, [reference]);
    const selected = window.__egdesk.state.codex.threads.find(item => item.id === threadId)?.briefingInputs || [];
    if (!selected.some(item => item.sourceId === reference.sourceId)) throw new Error('immutable reference was not attached to Chat draft');
    return true;
  }, { threadId: thread.id, reference });
  result.sourceStage = 'attached-to-draft';
  return { sourceId: reference.sourceId, snapshotId: reference.snapshotId, hash: reference.hash };
}

async function storedSource(harness, thread, reference) {
  return chrome(harness, async ({ threadId, reference }) => {
    const stored = await window.__egdesk.codexBridge.readInput(reference);
    if (!stored) throw new Error('production immutable inspector returned no source');
    return stored;
  }, { threadId: thread.id, reference });
}

async function createBrowserCards(harness, fixtureUrl, deadlineMs) {
  assertBeforeDeadline(deadlineMs);
  return chrome(harness, ({ uri }) => {
    const api = window.__egdesk;
    const target = api.cardRuntime.openBrowserCard(uri, { openMode: 'new' });
    const control = api.cardRuntime.openBrowserCard('about:blank', { openMode: 'new' });
    // Both fixture Cards overlap at creation; put the target's rendered menu
    // in front before the subsequent native UI click grants interaction.
    api.cardRuntime.focusCard(target);
    return { targetCardId: target.id, controlCardId: control.id };
  }, { uri: fixtureUrl });
}

async function selectBrowserInteraction(harness, thread, cardId, deadlineMs) {
  assertBeforeDeadline(deadlineMs);
  // Opening Chat can cover the fixture Card again. Foreground only the owned
  // target before using its real menu; never click through an overlapping view.
  await chrome(harness, cardId => {
    const card = document.getElementById(cardId);
    if (!card?.classList.contains('egd-browser-card')) throw new Error('QA Browser target is unavailable');
    window.__egdesk.cardRuntime.focusCard(card);
    return true;
  }, cardId);
  // B's UI menu is the explicit client permission path. Direct mutation of
  // inputSources or a helper request cannot substitute for this selection.
  await harness.click(`${selectorForId(cardId)} .egd-card-menu`);
  await harness.click('.egd-browser-menu-item[title^="이 Browser만 이번 Chat"]');
  return chrome(harness, ({ threadId, cardId }) => {
    const selected = window.__egdesk.browserAgentTools.selectedSources(threadId);
    if (selected.length !== 1 || selected[0].sourceRef?.viewId !== cardId ||
        selected[0].selectedByUser !== true || selected[0].browserToolPermission !== 'interact') {
      throw new Error('B UI interaction selection is not bound to exactly the QA card');
    }
    return { cardId, profileId: selected[0].sourceRef.profileId,
      uri: selected[0].sourceRef.uri,
      accountId: selected[0].sourceRef.accountId || '',
      sourceId: selected[0].id, cardEpoch: selected[0].browserToolIdentity?.cardEpoch || null,
      selectedByUser: true, permission: selected[0].browserToolPermission };
  }, { threadId: thread.id, cardId });
}

async function browserSnapshot(harness, targetCardId, controlCardId) {
  return chrome(harness, async ({ targetCardId, controlCardId }) => {
    const api = window.__egdesk;
    const card = document.getElementById(targetCardId);
    if (!card?.classList?.contains('egd-browser-card') ||
        typeof card._browserControls?.toolObserve !== 'function') {
      throw new Error('selected Browser Card has no independent actor observation path');
    }
    const binding = card._browserControls.toolBinding();
    // This read-only actor sample is separate from the model tool callback.
    // It supplies a document/revision/viewport witness absent from A's public
    // browser.tool.completed SSE event; do not label it as the model's guard.
    const actor = await card._browserControls.toolObserve(binding, { textLimit: 80, elementLimit: 80 });
    const control = await api.browserAgent.snapshot(controlCardId);
    if (actor?.cardId !== targetCardId ||
        typeof actor.documentId !== 'string' || !Number.isSafeInteger(actor.revision) ||
        !actor.viewport || !Array.isArray(actor.text) || !Array.isArray(actor.interactiveElements)) {
      throw new Error('independent Browser actor sample is not bound to the visible target document');
    }
    const input = actor.interactiveElements.find(item => item.label === 'QA note');
    const text = snapshot => Array.isArray(snapshot.text) ? snapshot.text.join('\n') : String(snapshot.text || '');
    const segments = snapshot => Array.isArray(snapshot.text) ? snapshot.text.map(String)
      : String(snapshot.text || '').split('\n');
    const targetInputFocused = !!input && actor.focusedElement?.ref === input.ref;
    const activeElement = document.activeElement;
    const focusedCardId = activeElement?.closest?.('.egd-browser-card')?.id || null;
    return { targetUrl: actor.url, targetDocumentId: actor.documentId,
      sampledAtMs: Date.now(),
      targetRevision: actor.revision, targetViewport: actor.viewport,
      targetProfileId: binding.profileId, targetCardEpoch: binding.cardEpoch,
      targetAccountId: binding.accountId,
      targetText: text(actor), targetSegments: segments(actor),
      targetInteractive: actor.interactiveElements.map(item => ({
        label: item.label || '', role: item.role || '', tag: item.tag || '' })),
      inputValue: input?.value || '',
      targetInputFocused, focusedCardId,
      activeElementId: activeElement?.id || null,
      activeElementTag: activeElement?.tagName?.toLowerCase?.() || null,
      controlText: text(control), controlInputValue: control.focusedElement?.value || '', controlCardId,
      cards: [...document.querySelectorAll('.egd-canvas-card')].map(node => node.id).sort(),
      camera: { pan: { ...api.state.panTarget }, zoom: api.state.zoomTarget,
        activeEntityId: api.state.activeEntityId || null } };
  }, { targetCardId, controlCardId });
}

const NEGATIVE_PROBE_NAMES = Object.freeze([
  'stale-revision-before-ui', 'forbidden-scheme-before-ui',
  'stale-dom-at-actor', 'resized-viewport-at-actor',
  'observe-only-interaction-denied', 'stop-before-first-bind-accept',
  'expired-request-before-actor', 'cancel-before-act',
  'readonly-fill-at-actor', 'disabled-fieldset-fill-at-actor', 'aria-disabled-ancestor-fill-at-actor',
]);

const CHILD_TARGET_PROBES = Object.freeze([
  { name: 'readonly-fill-at-actor', label: 'QA readonly note', disabled: false,
    reason: /not an editable field/i },
  { name: 'disabled-fieldset-fill-at-actor', label: 'QA fieldset note', disabled: true,
    reason: /target is unavailable/i },
  { name: 'aria-disabled-ancestor-fill-at-actor', label: 'QA ancestor note', disabled: true,
    reason: /target is unavailable/i },
]);

function assertProbeActionDiagnostic(request, cardId, phase, status) {
  const diagnostic = request?.actorDiagnostic;
  assert.ok(diagnostic?.cardId === cardId && diagnostic.phase === phase && diagnostic.status === status
    && diagnostic.actionType === request.action?.type
    && diagnostic.sampledAtMs >= request.attemptedAt && diagnostic.sampledAtMs <= request.respondedAt,
  'fixture action diagnostic lacks the current actor phase/receipt');
}

function assertProbeGuard(request, snapshot, target) {
  assert.deepEqual(request.guard, { documentId: snapshot.documentId, revision: snapshot.revision,
    viewport: snapshot.viewport, url: snapshot.url,
    focusedRef: snapshot.focusedElement?.ref || null, target },
  'fixture action lost its exact observed guard');
  assert.equal(request.action?.ref, target?.ref, 'fixture action changed its observed target');
  assert.equal(request.action?.selector, undefined, 'fixture action cannot use a selector fallback');
}

function assertGuardedPositiveControls(proof, actorDocumentId) {
  assertBrowserFixtureConfig(proof.fixture?.url, proof.fixture?.marker);
  assert.deepEqual(proof.guardedActorPositiveControls?.map(item => item.action), ['fill', 'click'],
    'guarded fill/click positive controls are incomplete');
  for (const item of proof.guardedActorPositiveControls) {
    assert.ok(item.cardId === proof.cardId && item.simulatorOnly === true && item.sourceId
      && item.cardEpoch && item.syntheticRunId?.startsWith('qa-browser-simulator-'),
    'guarded positive control lost owned selected-Card scope');
    const { observed, afterObserved, beforeAttempt, afterAttempt, receipt } = item;
    assert.ok(observed?.status === 'observed' && afterObserved?.status === 'observed'
      && observed.cardId === proof.cardId && afterObserved.cardId === proof.cardId
      && observed.observationId && afterObserved.observationId
      && observed.observationId !== afterObserved.observationId,
    'guarded positive control lacks a fresh B observation');
    for (const snapshot of [observed.snapshot, beforeAttempt, receipt?.after, afterObserved.snapshot, afterAttempt]) {
      assert.ok(snapshot?.cardId === proof.cardId && snapshot.documentId === actorDocumentId
        && snapshot.url === proof.fixture.url && snapshot.text?.includes(proof.fixture.marker)
        && Number.isSafeInteger(snapshot.revision) && snapshot.viewport,
      'guarded positive control lost current fixture document evidence');
    }
    const counterBefore = beforeAttempt.qaDiagnostics, counterAfter = afterAttempt.qaDiagnostics;
    assert.ok(counterBefore?.kind === 'actor-perform-entry' && counterAfter?.kind === 'actor-perform-entry'
      && counterBefore.actorDocumentId === actorDocumentId && counterAfter.actorDocumentId === actorDocumentId
      && Number.isSafeInteger(counterBefore.performCalls) && counterBefore.performCalls >= 0
      && counterAfter.performCalls === counterBefore.performCalls + 1,
    'guarded positive control did not enter perform exactly once');
    const requests = item.uiRequests;
    assert.ok(Array.isArray(requests) && requests.every(request => request.requestId
      && request.responseRequestId === request.requestId && request.runId === item.syntheticRunId
      && request.cardId === proof.cardId && request.targetCardEpoch === item.cardEpoch
      && Number.isFinite(request.attemptedAt) && request.respondedAt >= request.attemptedAt),
    'guarded positive control lost UI receipt correlation');
    const acts = requests.filter(request => request.kind === 'act');
    assert.equal(acts.length, 1, 'guarded positive control must have exactly one UI act');
    const acted = acts[0];
    assert.ok(acted.status === 'acted' && acted.action?.type === item.action,
      'guarded positive control lacks an acted UI receipt');
    const target = observed.snapshot.interactiveElements.find(element => element.ref === acted.action.ref);
    assert.ok(target && !target.disabled && target.label === (item.action === 'fill' ? 'QA note' : 'Reveal QA details'),
      'guarded positive control targeted another fixture element');
    assertProbeGuard(acted, observed.snapshot, target);
    assertProbeActionDiagnostic(acted, proof.cardId, 'post-actor', 'acted');
    assert.ok(requests.slice(requests.indexOf(acted) + 1).some(request => request.kind === 'observe'
      && request.status === 'observed' && request.attemptedAt >= acted.respondedAt),
    'guarded positive control has no post-action UI observation');
    assert.ok(receipt.status === 'postcondition-observed' && receipt.cardId === proof.cardId
      && receipt.action === item.action && receipt.externalEffectVerified === false
      && receipt.dispatchReceipt?.actor === 'JSWindowActor'
      && receipt.dispatchReceipt.eventDispatched === true && receipt.dispatchReceipt.documentStillCurrent === true,
    'guarded positive control lacks a current actor receipt');
    const value = item.action === 'fill' ? 'QA_GUARDED_FILL_CONTROL' : 'QA click count: 2';
    assert.deepEqual(receipt.postcondition, { kind: item.action === 'fill' ? 'target-value' : 'visible-text',
      value, matched: true, wasAlreadyTrue: false }, 'guarded positive control lacks a new bounded postcondition');
    const matched = snapshot => item.action === 'fill'
      ? snapshot.interactiveElements?.find(element => element.ref === target.ref)?.value === value
      : snapshot.text.includes(value);
    assert.ok(!matched(observed.snapshot) && !matched(beforeAttempt)
      && [receipt.after, afterObserved.snapshot, afterAttempt].every(matched),
    'guarded positive control postcondition is not independently observed');
    if (item.action === 'fill') assert.equal(acted.action.text, value);
    else assert.ok(receipt.dispatchReceipt.clickInputRoute === 'dom-click-no-pointerdown'
      && receipt.dispatchReceipt.targetClickObserved === true,
    'guarded click lacks its focus-safe target event receipt');
  }
}

export function assertBrowserNegativeProbeResults(proof) {
  assert.equal(proof?.simulatorOnly, true, 'negative probes must be marked test-only');
  assert.equal(proof?.nativeModelOriginVerified, false,
    'synthetic Browser probes cannot claim native-model origin');
  assert.equal(proof?.providerTurns, 0, 'synthetic Browser probes started a provider turn');
  assert.equal(proof?.actorPhysicalDispatchCounterVerified, false,
    'negative probes cannot claim an unpublished physical-dispatch counter');
  assert.equal(proof?.actorPerformCounterVerified, true, 'live actor perform-entry counter was not verified');
  const control = proof.actorPerformPositiveControl;
  assert.ok(control?.cardId === proof.cardId && typeof control.actorDocumentId === 'string'
    && Number.isSafeInteger(control.before) && control.before >= 0 && control.after === control.before + 1,
  'live actor counter lacks its controlled positive action');
  assertGuardedPositiveControls(proof, control.actorDocumentId);
  assert.deepEqual((proof?.probes || []).map(item => item.name), NEGATIVE_PROBE_NAMES,
    'bounded Browser negative probes are incomplete');
  assert.ok(proof.probes.every(item => item.denied === true
    && item.ownedFixtureContentUnchangedAfterDeniedAction === true
    && item.cardId === proof.cardId && item.simulatorOnly === true
    && typeof item.sourceId === 'string' && !!item.sourceId
    && typeof item.cardEpoch === 'string' && !!item.cardEpoch
    && typeof item.syntheticRunId === 'string'
    && item.syntheticRunId.startsWith('qa-browser-simulator-')),
  'Browser negative probe lacks an owned-Card denial and independent no-effect check');
  for (const item of proof.probes) {
    assert.equal(item.actorDocumentId, control.actorDocumentId, `${item.name} crossed actor documents`);
    assert.ok(Number.isSafeInteger(item.actorPerformCallsBefore) && item.actorPerformCallsBefore >= 0,
      `${item.name} has no live before counter`);
    assert.equal(item.actorPerformCallsAfter, item.actorPerformCallsBefore, `${item.name} entered the actor perform dispatcher`);
    assert.ok(item.beforeAttempt && item.afterAttempt, `${item.name} lacks independent fixture observations`);
    assert.equal(item.beforeAttempt.documentId, item.actorDocumentId, `${item.name} before observation crossed documents`);
    assert.equal(item.afterAttempt.documentId, item.actorDocumentId, `${item.name} after observation crossed documents`);
    assert.equal(item.beforeAttempt.actorPerformCalls, item.actorPerformCallsBefore, `${item.name} before counter differs from the observation`);
    assert.equal(item.afterAttempt.actorPerformCalls, item.actorPerformCallsAfter, `${item.name} after counter differs from the observation`);
    assert.deepEqual(item.afterAttempt, item.beforeAttempt, `${item.name} changed the independently observed fixture`);
    assert.ok(Array.isArray(item.uiRequests) && item.uiRequests.length > 0, `${item.name} has no live UI protocol receipts`);
    for (const request of item.uiRequests) {
      assert.ok(typeof request.requestId === 'string' && request.requestId
        && request.responseRequestId === request.requestId
        && request.runId === item.syntheticRunId && request.cardId === proof.cardId
        && request.targetCardEpoch === item.cardEpoch
        && Number.isFinite(request.attemptedAt) && request.respondedAt >= request.attemptedAt
        && ['bound', 'observed', 'rejected', 'cancelled'].includes(request.status),
      `${item.name} UI receipt lost request/run/Card correlation`);
    }
    const acts = item.uiRequests.filter(request => request.kind === 'act');
    const expectedActs = item.uiProtocolActRequests ?? item.uiActRequests ?? 0;
    assert.equal(acts.length, expectedActs, `${item.name} UI act receipt count differs from its claim`);
    assert.ok(acts.every(request => request.status === 'rejected' && typeof request.error === 'string' && request.error),
      `${item.name} has no actual rejected UI act receipt`);
    if (item.uiRequestId) assert.ok(acts.some(request => request.requestId === item.uiRequestId),
      `${item.name} rejected UI request ID is not in its trace`);
  }
  const [revision, scheme, dom, resize, permission, stop, expired, cancelled] = proof.probes;
  assert.ok(revision.code === 'BROWSER_OBSERVATION_STALE' && revision.uiActRequests === 0
    && scheme.code === 'INVALID_BROWSER_TOOL' && scheme.serviceActRequests === 0
    && scheme.uiProtocolDenied === true
    && dom.code === 'BROWSER_ACTION_UNVERIFIED' && dom.uiActRequests === 1
    && resize.code === 'BROWSER_ACTION_UNVERIFIED' && resize.uiActRequests === 1
    && permission.code === 'BROWSER_INTERACTION_NOT_GRANTED'
    && permission.serviceActRequests === 0 && permission.uiProtocolDenied === true
    && ['BROWSER_BINDING_STALE', 'BROWSER_RUN_ENDED'].includes(stop.code)
    && stop.cancelledBeforeBindAccepted === true && stop.uiActRequests === 0,
  'Browser negative probe receipts do not match the scoped B/UI guard outcomes');
  assert.ok(expired.code === null && expired.uiStatus === 'rejected'
    && /expired/i.test(expired.uiReason) && expired.requestDeadlineMs <= expired.attemptedAt
    && expired.uiRequests.some(item => item.requestId === expired.uiRequestId && item.status === 'rejected'
      && item.kind === 'act' && item.deadlineMs === expired.requestDeadlineMs),
  'expired request lacks a correlated actual UI denial');
  assert.ok(cancelled.code === 'BROWSER_RUN_ENDED' && cancelled.uiStatus === 'rejected'
    && /cancelled/i.test(cancelled.uiReason) && cancelled.serviceActRequestsAfterCancel === 0
    && cancelled.cancelReceipt?.status === 'cancelled'
    && cancelled.cancelReceipt.runId === cancelled.syntheticRunId && cancelled.cancelReceipt.cardId === proof.cardId
    && cancelled.cancelReceipt.at <= cancelled.attemptedAt
    && cancelled.uiRequests.some(item => item.kind === 'cancel' && item.requestId === cancelled.cancelReceipt.requestId
      && item.status === 'cancelled' && item.respondedAt === cancelled.cancelReceipt.at)
    && cancelled.uiRequests.some(item => item.requestId === cancelled.uiRequestId && item.status === 'rejected'
      && item.kind === 'act' && item.deadlineMs > item.attemptedAt),
  'cancelled request lacks its earlier owned cancellation and actual UI denial');
  for (const spec of CHILD_TARGET_PROBES) {
    const item = proof.probes.find(probe => probe.name === spec.name);
    const request = item.uiRequests.find(request => request.kind === 'act');
    const target = item.beforeAttempt.interactiveElements?.find(element => element.label === spec.label);
    assert.ok(target?.tag === 'input' && target.value === '' && target.disabled === spec.disabled,
      `${spec.name} lacks the expected live fixture target`);
    assert.ok(item.code === null && item.uiActRequests === 1 && request.action?.type === 'fill'
      && request.action.text === 'QA_CHILD_DENIAL_MUST_NOT_FILL' && spec.reason.test(request.error),
    `${spec.name} lacks the specific Child target denial`);
    assertProbeGuard(request, item.beforeAttempt, target);
    assertProbeActionDiagnostic(request, proof.cardId, 'actor', 'rejected');
  }
  assert.equal(proof.requestsScopedToOwnedCard, true,
    'negative probes targeted a Card other than the newly owned fixture');
  assert.equal(proof.preexistingBrowserCardStylesUnchanged, true,
    'negative probes changed a preexisting Browser Card inline style');
  assert.equal(proof.canvasPanZoomUnchanged, true,
    'negative probes moved the Canvas camera');
  return true;
}

const probeId = prefix => `${prefix}-${randomBytes(8).toString('hex')}`;

export function browserViewportChanged(before, after) {
  return Boolean(before && after && ['width', 'height', 'devicePixelRatio'].some(key => before[key] !== after[key]));
}

async function ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture) {
  const observed = await chrome(harness, async ({ cardId, ownerTag, fixture }) => {
    const card = document.getElementById(cardId);
    if (!card?.isConnected || !card.classList?.contains('egd-browser-card')
        || card.dataset.egdeskQaNegativeOwner !== ownerTag) {
      throw new Error('negative probe Card is not the newly owned QA fixture');
    }
    const binding = card._browserControls.toolBinding();
    const snapshot = await card._browserControls.toolObserve(binding,
      { textLimit: 80, elementLimit: 80,
        qaDiagnostics: { fixtureUrl: fixture.url, fixtureMarker: fixture.marker } });
    return { binding, snapshot,
      inputValue: snapshot.interactiveElements?.find(item => item.label === 'QA note')?.value || '',
      cardStyle: { width: card.style.width, height: card.style.height } };
  }, { cardId, ownerTag, fixture });
  assert.equal(observed.binding?.cardId, cardId, 'negative probe Card binding changed');
  assert.equal(observed.binding?.accountId, '', 'negative probe Card is account-linked');
  assert.equal(observed.snapshot?.cardId, cardId, 'negative probe actor observed another Card');
  assert.equal(observed.snapshot?.url, fixture.url, 'negative probe navigated from the owned fixture');
  assert.ok(observed.snapshot.text?.includes(fixture.marker),
    'negative probe actor did not observe the exact local fixture marker');
  assert.ok(Number.isSafeInteger(observed.snapshot.revision)
    && typeof observed.snapshot.documentId === 'string' && observed.snapshot.documentId
    && observed.snapshot.viewport, 'negative probe actor lacks document/revision/viewport evidence');
  const diagnostic = observed.snapshot.qaDiagnostics;
  assert.equal(diagnostic?.kind, 'actor-perform-entry', 'owned fixture lacks the live actor perform-entry diagnostic');
  assert.equal(diagnostic.actorDocumentId, observed.snapshot.documentId, 'actor diagnostic belongs to another document');
  assert.ok(Number.isSafeInteger(diagnostic.performCalls) && diagnostic.performCalls >= 0,
    'invalid actor perform-entry counter');
  return observed;
}

function assertNegativeNoEffect(before, after, label) {
  assert.equal(after.snapshot.url, before.snapshot.url, `${label} changed the fixture URL`);
  assert.equal(after.snapshot.documentId, before.snapshot.documentId,
    `${label} changed the fixture document`);
  assert.deepEqual(after.snapshot.text, before.snapshot.text,
    `${label} changed the fixture visible DOM`);
  assert.equal(after.inputValue, before.inputValue, `${label} changed the harmless fixture input`);
  const oldCounter = before.snapshot.qaDiagnostics, newCounter = after.snapshot.qaDiagnostics;
  assert.equal(oldCounter?.kind, 'actor-perform-entry', `${label} has no before actor counter`);
  assert.equal(newCounter?.kind, 'actor-perform-entry', `${label} has no after actor counter`);
  assert.equal(oldCounter.actorDocumentId, before.snapshot.documentId, `${label} before diagnostic crossed documents`);
  assert.equal(newCounter.actorDocumentId, after.snapshot.documentId, `${label} after diagnostic crossed documents`);
  assert.ok(Number.isSafeInteger(oldCounter.performCalls) && oldCounter.performCalls >= 0, `${label} before counter is invalid`);
  assert.equal(newCounter.performCalls, oldCounter.performCalls, `${label} entered the actor perform dispatcher`);
  const observed = value => ({ url: value.snapshot.url, documentId: value.snapshot.documentId,
    revision: value.snapshot.revision, viewport: value.snapshot.viewport, text: value.snapshot.text,
    interactiveElements: value.snapshot.interactiveElements, focusedElement: value.snapshot.focusedElement,
    inputValue: value.inputValue, actorPerformCalls: value.snapshot.qaDiagnostics.performCalls });
  const beforeAttempt = observed(before), afterAttempt = observed(after);
  assert.deepEqual(afterAttempt, beforeAttempt, `${label} changed the independently observed fixture`);
  return { beforeAttempt, afterAttempt, actorDocumentId: oldCounter.actorDocumentId,
    actorPerformCallsBefore: oldCounter.performCalls, actorPerformCallsAfter: newCounter.performCalls };
}

async function selectOwnedProbeSource(harness, thread, cardId, ownerTag, permission, fixture,
  additionalOwnedCardId = null) {
  assert.ok(['observe', 'interact'].includes(permission), 'negative probe permission is invalid');
  await chrome(harness, ({ cardId, ownerTag }) => {
    const card = document.getElementById(cardId);
    if (!card?.isConnected || card.dataset.egdeskQaNegativeOwner !== ownerTag)
      throw new Error('negative probe focus escaped the owned fixture Card');
    window.__egdesk.cardRuntime.focusCard(card);
    return true;
  }, { cardId, ownerTag });
  await harness.click(`${selectorForId(cardId)} .egd-card-menu`);
  await harness.click(permission === 'interact'
    ? '.egd-browser-menu-item[title^="이 Browser만 이번 Chat"]'
    : '.egd-browser-menu-item[title^="현재 Browser의 읽기 자료만"]');
  const source = await chrome(harness, ({ threadId, cardId, ownerTag, additionalOwnedCardId }) => {
    const card = document.getElementById(cardId);
    if (!card?.isConnected || card.dataset.egdeskQaNegativeOwner !== ownerTag)
      throw new Error('Browser probe selection escaped the owned fixture Card');
    const selected = window.__egdesk.browserAgentTools.selectedSources(threadId);
    const expected = [cardId, ...(additionalOwnedCardId ? [additionalOwnedCardId] : [])].sort();
    if (JSON.stringify(selected.map(item => item.sourceRef?.viewId).sort()) !== JSON.stringify(expected))
      throw new Error('negative probe selected more than the owned Browser Card');
    return selected.find(item => item.sourceRef?.viewId === cardId);
  }, { threadId: thread.id, cardId, ownerTag, additionalOwnedCardId });
  assert.equal(source.browserToolPermission, permission,
    'negative probe UI permission differs from the selected menu action');
  assert.equal(source.selectedByUser, true, 'negative probe lacks the rendered UI selection');
  assert.equal(source.sourceRef?.uri, fixture.url, 'negative probe selected another URL');
  assert.equal(source.sourceRef?.accountId, '', 'negative probe selected an account-linked Card');
  assert.equal(source.browserToolSelection?.threadId, thread.wireClientThreadId,
    'negative probe source token belongs to another Chat thread');
  return source;
}

async function newNegativeService(harness, thread, cardId, source, deadlineMs,
  { holdFirstBind = false } = {}) {
  // This B service instance uses a synthetic run and direct test-only UI
  // dispatcher. It never registers with A or claims model/native origin.
  const { createBrowserToolService } = await import('../helper/egdesk-browser-tool-runtime.mjs');
  const ownerKey = source.browserToolIdentity?.engineAccountKey;
  assert.ok(typeof ownerKey === 'string' && ownerKey,
    'negative probe has no current Engine owner binding');
  const trace = { requests: [], heldBindRequest: null, releaseBind: null, binding: null };
  const uiDispatch = async request => {
    assertBeforeDeadline(deadlineMs);
    assert.equal(request.cardId, cardId, 'negative probe requested another Card');
    assert.equal(request.clientThreadId, thread.wireClientThreadId,
      'negative probe requested another Chat thread');
    assert.equal(request.targetCardEpoch, source.browserToolIdentity.cardEpoch,
      'negative probe crossed Card epochs');
    const sampled = await chrome(harness, async request => {
      const attemptedAt = Date.now();
      const response = await window.__egdesk.browserAgentTools.dispatch(request);
      const actorDiagnostic = request.kind === 'act'
        ? window.__egdesk.browserAgentTools.fixtureActionDiagnostic(request.cardId) : null;
      return { attemptedAt, respondedAt: Date.now(), response, actorDiagnostic };
    }, request);
    const response = sampled.response;
    assert.equal(response?.requestId, request.requestId, 'negative UI response belongs to another request');
    trace.requests.push({ kind: request.kind, requestId: request.requestId,
      responseRequestId: response.requestId, runId: request.runId,
      clientThreadId: request.clientThreadId, cardId: request.cardId,
      targetCardEpoch: request.targetCardEpoch, deadlineMs: request.deadlineMs,
      attemptedAt: sampled.attemptedAt, respondedAt: sampled.respondedAt,
      ...(request.kind === 'act' ? { action: request.action, guard: request.guard,
        actorDiagnostic: sampled.actorDiagnostic } : {}),
      status: response?.status || null, error: String(response?.error || '').slice(0, 200) });
    if (request.kind === 'bind' && response?.binding) trace.binding = response.binding;
    return response;
  };
  const sendToUi = request => {
    if (holdFirstBind && request.kind === 'bind' && !trace.heldBindRequest) {
      trace.heldBindRequest = request;
      return new Promise(resolve => { trace.releaseBind = () => resolve(uiDispatch(request)); });
    }
    return uiDispatch(request);
  };
  const service = createBrowserToolService({ sendToUi, getOwnerKey: () => ownerKey });
  const prepared = service.prepare({ selectedSources: [source], ownerKey });
  const runId = probeId('qa-browser-simulator');
  const run = { answerId: `qa-browser-simulator/${runId}`, runId,
    clientThreadId: thread.wireClientThreadId, status: 'inProgress' };
  return { service, prepared, run, trace, uiDispatch };
}

async function expectNegativeCode(operation, codes, label) {
  try { await operation; assert.fail(`${label} unexpectedly succeeded`); }
  catch (error) {
    assert.ok(codes.includes(error?.code),
      `${label} returned ${error?.code || error?.message || 'unknown'} instead of ${codes.join('/')}`);
    return error.code;
  }
}

export function browserCameraSurfacePlan(worldRect, viewport) {
  const { x, y, width, height } = worldRect || {};
  assert.ok([x, y, width, height, viewport?.width, viewport?.height].every(Number.isFinite)
    && width > 0 && height > 0 && viewport.width > 160 && viewport.height > 160,
  'camera surface-isolation fixture has no usable measured geometry');
  const zoom = Math.min(1, (viewport.width - 160) / width, (viewport.height - 160) / height);
  assert.ok(zoom >= 0.02, 'camera surface-isolation fixture cannot fit the current viewport');
  const offscreenZoom = zoom * 0.8;
  return {
    visible: { zoom, pan: { x: (viewport.width - width * zoom) / 2 - x * zoom,
      y: (viewport.height - height * zoom) / 2 - y * zoom } },
    offscreen: { zoom: offscreenZoom,
      pan: { x: -64 - (x + width) * offscreenZoom, y: -64 - (y + height) * offscreenZoom } },
  };
}

async function ownedCameraSurfaceSnapshot(harness, cardId, ownerTag) {
  return chrome(harness, ({ cardId, ownerTag }) => {
    const api = window.__egdesk;
    const card = document.getElementById(cardId);
    if (!card?.isConnected || card.dataset.egdeskQaNegativeOwner !== ownerTag)
      throw new Error('camera surface-isolation escaped its owned Card');
    const browser = card._browserControls.toolBrowser();
    const rect = card.getBoundingClientRect();
    const style = getComputedStyle(card);
    const px = (value, fallback) => Number.isFinite(parseFloat(value)) ? parseFloat(value) : fallback;
    return { cardId, browsingContextId: String(browser.browsingContext.id),
      worldRect: { x: px(card.style.left, card.offsetLeft), y: px(card.style.top, card.offsetTop),
        width: card.offsetWidth, height: card.offsetHeight },
      geometryStyle: { left: card.style.left, top: card.style.top, width: card.style.width, height: card.style.height },
      rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      display: style.display, visibility: style.visibility,
      camera: { pan: { ...api.state.panTarget }, zoom: api.state.zoomTarget,
        actualPan: { ...api.state.pan }, actualZoom: api.state.zoom } };
  }, { cardId, ownerTag });
}

export function assertBrowserCameraSurfaceIsolation(proof) {
  assert.equal(proof?.scope, 'browser-camera-surface-isolation');
  assert.equal(proof.inputRoute, 'dom-click-no-pointerdown');
  assert.equal(proof.coordinateInputVerified, false);
  assert.deepEqual(proof.untested, ['frame-targeting', 'page-zoom', 'device-pixel-ratio']);
  assert.equal(proof.simulatorOnly, true);
  assert.equal(proof.nativeModelOriginVerified, false);
  assert.equal(proof.providerTurns, 0);
  assert.equal(proof.externalEffectVerified, false);
  assertBrowserFixtureConfig(proof.fixture?.url, proof.fixture?.marker);
  assert.ok(proof.cardId && proof.cardId !== proof.priorCardId && proof.sourceId && proof.cardEpoch
    && proof.syntheticRunId?.startsWith('qa-browser-simulator-'), 'camera case needs a separately owned Card');
  const { visible, offscreen, afterClick, observed, afterObserved, beforeAttempt, afterAttempt, receipt } = proof;
  browserCameraSurfacePlan(visible?.worldRect, visible?.viewport);
  const validRect = rect => rect && ['left', 'top', 'right', 'bottom', 'width', 'height']
    .every(key => Number.isFinite(rect[key])) && rect.width > 0 && rect.height > 0
    && Math.abs(rect.right - rect.left - rect.width) < 0.01
    && Math.abs(rect.bottom - rect.top - rect.height) < 0.01;
  const isOffscreen = surface => surface.rect.right <= 0 || surface.rect.bottom <= 0
    || surface.rect.left >= surface.viewport.width || surface.rect.top >= surface.viewport.height;
  for (const surface of [visible, offscreen, afterClick]) {
    assert.ok(surface?.cardId === proof.cardId && /^[1-9][0-9]*$/.test(surface.browsingContextId)
      && validRect(surface.rect)
      && surface.viewport?.width > 0 && surface.viewport?.height > 0,
    'camera case lacks measured Card/context/screen rectangles');
    assert.equal(surface.browsingContextId, visible.browsingContextId, 'camera change replaced the browsing context');
    assert.deepEqual(surface.worldRect, visible.worldRect, 'camera case moved or resized the Card world rect');
    assert.deepEqual(surface.geometryStyle, visible.geometryStyle, 'camera case changed Card geometry styles');
    assert.deepEqual(surface.viewport, visible.viewport, 'camera case resized the outer viewport');
    assert.deepEqual(surface.camera.actualPan, surface.camera.pan, 'camera surface sample was still panning');
    assert.equal(surface.camera.actualZoom, surface.camera.zoom, 'camera surface sample was still zooming');
  }
  assert.ok(visible.display !== 'none' && visible.visibility !== 'hidden'
    && visible.rect.left >= 0 && visible.rect.top >= 0
    && visible.rect.right <= visible.viewport.width && visible.rect.bottom <= visible.viewport.height,
  'camera case lacks an actually visible baseline');
  assert.ok(isOffscreen(offscreen) && isOffscreen(afterClick), 'camera case did not observe an offscreen Card');
  assert.notDeepEqual(offscreen.camera.pan, visible.camera.pan, 'camera case did not pan');
  assert.notEqual(offscreen.camera.zoom, visible.camera.zoom, 'camera case did not zoom');
  assert.deepEqual(afterClick.camera, offscreen.camera, 'guarded DOM click moved the camera');
  assert.deepEqual(proof.beforeClickSurface, offscreen, 'camera/context changed after the offscreen observation');
  for (const observation of [proof.visibleObserved, observed, afterObserved]) {
    assert.ok(observation?.status === 'observed' && observation.cardId === proof.cardId,
      'camera case lacks a successful observation of its Card');
  }
  assert.ok(proof.visibleObserved?.observationId && observed?.observationId && afterObserved?.observationId
    && new Set([proof.visibleObserved.observationId, observed.observationId, afterObserved.observationId]).size === 3,
  'camera case reused an observation across camera/action changes');
  const documentId = proof.visibleObserved.snapshot?.documentId;
  for (const snapshot of [proof.visibleObserved.snapshot, observed.snapshot, beforeAttempt,
    receipt?.after, afterObserved.snapshot, afterAttempt]) {
    assert.ok(snapshot?.cardId === proof.cardId && snapshot.documentId === documentId && documentId
      && snapshot.url === proof.fixture.url && snapshot.text?.includes(proof.fixture.marker),
    'camera case replaced the actor document or escaped its local fixture');
    assert.deepEqual(snapshot.viewport, proof.visibleObserved.snapshot.viewport,
      'camera-only case changed the content viewport');
  }
  const requests = proof.uiRequests;
  assert.ok(Array.isArray(requests) && requests.every(request => request.cardId === proof.cardId
    && request.targetCardEpoch === proof.cardEpoch && request.runId === proof.syntheticRunId
    && request.requestId && request.responseRequestId === request.requestId
    && Number.isFinite(request.attemptedAt) && request.respondedAt >= request.attemptedAt),
  'camera case lost request/run/Card correlation');
  const acts = requests.filter(request => request.kind === 'act');
  assert.equal(acts.length, 1, 'camera case must dispatch exactly one guarded click');
  const acted = acts[0];
  assert.ok(acted.status === 'acted' && acted.action?.type === 'click');
  const target = observed.snapshot.interactiveElements?.find(item => item.ref === acted.action.ref);
  assert.ok(target?.tag === 'button' && target.label === 'Reveal QA details' && target.disabled === false);
  assertProbeGuard(acted, observed.snapshot, target);
  assertProbeActionDiagnostic(acted, proof.cardId, 'post-actor', 'acted');
  assert.ok(requests.slice(requests.indexOf(acted) + 1).some(request => request.kind === 'observe'
    && request.status === 'observed' && request.attemptedAt >= acted.respondedAt),
  'camera case lacks post-click observation');
  assert.ok(receipt.status === 'postcondition-observed' && receipt.cardId === proof.cardId
    && receipt.action === 'click' && receipt.externalEffectVerified === false
    && receipt.dispatchReceipt?.actor === 'JSWindowActor' && receipt.dispatchReceipt.eventDispatched === true
    && receipt.dispatchReceipt.documentStillCurrent === true
    && receipt.dispatchReceipt.clickInputRoute === 'dom-click-no-pointerdown'
    && receipt.dispatchReceipt.targetClickObserved === true, 'camera case lacks the scoped DOM click receipt');
  assert.deepEqual(receipt.postcondition,
    { kind: 'visible-text', value: 'QA click count: 1', matched: true, wasAlreadyTrue: false });
  for (const snapshot of [proof.visibleObserved.snapshot, observed.snapshot, beforeAttempt])
    assert.ok(snapshot.text.includes('QA click count: 0') && !snapshot.text.includes('QA click count: 1'),
      'camera setup already changed the fixture click count');
  for (const snapshot of [receipt.after, afterObserved.snapshot, afterAttempt])
    assert.ok(snapshot.text.includes('QA click count: 1') && !snapshot.text.includes('QA click count: 0'),
      'camera click count was not independently read back');
  const before = beforeAttempt.qaDiagnostics, after = afterAttempt.qaDiagnostics;
  assert.ok(before?.kind === 'actor-perform-entry' && after?.kind === 'actor-perform-entry'
    && before.actorDocumentId === documentId && after.actorDocumentId === documentId
    && before.performCalls === 0 && after.performCalls === 1,
  'camera case did not enter the fresh actor perform dispatcher exactly once');
  assert.deepEqual(proof.restoredCamera.pan, proof.originalCamera.pan, 'camera pan was not restored');
  assert.equal(proof.restoredCamera.zoom, proof.originalCamera.zoom, 'camera zoom was not restored');
  assert.deepEqual(proof.restoredCamera.actualPan, proof.originalCamera.pan, 'restored camera is still panning');
  assert.equal(proof.restoredCamera.actualZoom, proof.originalCamera.zoom, 'restored camera is still zooming');
  assert.deepEqual(proof.selectionAfter, proof.selectionBefore, 'camera case left an extra selected source');
  assert.ok(proof.priorFixture?.cardId === proof.priorCardId && proof.priorFixture.beforeAttempt
    && proof.priorFixture.afterAttempt && proof.priorFixture.actorDocumentId,
  'camera case lacks independent earlier-fixture evidence');
  assert.deepEqual(proof.priorFixture.afterAttempt, proof.priorFixture.beforeAttempt,
    'camera case changed the earlier owned fixture');
  return true;
}

export async function runBrowserCameraSurfaceIsolation(harness, fixture, deadlineMs, thread,
  priorCardId, priorOwnerTag, result = {}) {
  assertBeforeDeadline(deadlineMs);
  const saved = await chrome(harness, threadId => {
    const api = window.__egdesk;
    return { camera: { pan: { ...api.state.panTarget }, zoom: api.state.zoomTarget },
      selection: api.browserAgentTools.selectedSources(threadId).map(item =>
        ({ id: item.id, cardId: item.sourceRef.viewId, permission: item.browserToolPermission })) };
  }, thread.id);
  assert.ok(saved.selection.length === 0 || (saved.selection.length === 1
    && saved.selection[0].cardId === priorCardId),
  'camera case initial selection must be empty or exactly the earlier owned Card');
  // The earlier Card survives cancellation, but its one-run selection grant does not.
  const priorSelectedCardId = saved.selection[0]?.cardId || null;
  const priorFixture = await ownedNegativeBrowserSnapshot(harness, priorCardId, priorOwnerTag, fixture);
  const ownerTag = probeId('lane-c-camera-owner');
  const proof = { scope: 'browser-camera-surface-isolation', inputRoute: 'dom-click-no-pointerdown',
    coordinateInputVerified: false, untested: ['frame-targeting', 'page-zoom', 'device-pixel-ratio'],
    simulatorOnly: true, nativeModelOriginVerified: false, providerTurns: 0, externalEffectVerified: false,
    fixture, priorCardId, originalCamera: saved.camera, selectionBefore: saved.selection };
  result.browserCameraSurfaceIsolation = proof;
  let unit;
  try {
    proof.cardId = await chrome(harness, ({ url, ownerTag }) => {
      const card = window.__egdesk.cardRuntime.openBrowserCard(url, { openMode: 'new' });
      card.dataset.egdeskQaNegativeOwner = ownerTag;
      return card.id;
    }, { url: fixture.url, ownerTag });
    assert.notEqual(proof.cardId, priorCardId, 'camera case reused the earlier fixture Card');
    await waitUntil(async () => {
      assertBeforeDeadline(deadlineMs);
      try { return await ownedNegativeBrowserSnapshot(harness, proof.cardId, ownerTag, fixture); }
      catch { return null; }
    }, Boolean, { timeoutMs: Math.min(15000, deadlineMs - Date.now()), intervalMs: 200 });
    const initialSurface = await ownedCameraSurfaceSnapshot(harness, proof.cardId, ownerTag);
    const plan = browserCameraSurfacePlan(initialSurface.worldRect, initialSurface.viewport);
    const setCamera = async camera => {
      assertBeforeDeadline(deadlineMs);
      await chrome(harness, camera => {
        window.__egdesk.state.setCanvasViewportTarget(camera, { immediate: true });
        return true;
      }, camera);
    };
    await setCamera(plan.visible);
    const source = await selectOwnedProbeSource(harness, thread, proof.cardId, ownerTag, 'interact', fixture, priorSelectedCardId);
    unit = await newNegativeService(harness, thread, proof.cardId, source, deadlineMs);
    Object.assign(proof, { sourceId: source.id, cardEpoch: source.browserToolIdentity.cardEpoch,
      syntheticRunId: unit.run.runId });
    await unit.service.bind(unit.run, unit.prepared);
    const observe = () => unit.service.dispatch(unit.run, { tool: BROWSER_TOOL_NAMES.observe,
      callId: probeId('qa-camera-observe'), arguments: { cardId: proof.cardId } });
    proof.visibleObserved = await observe();
    proof.visible = await ownedCameraSurfaceSnapshot(harness, proof.cardId, ownerTag);
    assert.ok(proof.visible.display !== 'none' && proof.visible.visibility !== 'hidden'
      && proof.visible.rect.width > 0 && proof.visible.rect.height > 0
      && proof.visible.rect.left >= 0 && proof.visible.rect.top >= 0
      && proof.visible.rect.right <= proof.visible.viewport.width
      && proof.visible.rect.bottom <= proof.visible.viewport.height, 'actual Card baseline is not visible');
    await setCamera(plan.offscreen);
    proof.offscreen = await ownedCameraSurfaceSnapshot(harness, proof.cardId, ownerTag);
    const rect = proof.offscreen.rect;
    assert.ok(rect.right <= 0 || rect.bottom <= 0 || rect.left >= proof.offscreen.viewport.width
      || rect.top >= proof.offscreen.viewport.height, 'actual Card rect did not move offscreen');
    proof.observed = await observe();
    proof.beforeAttempt = (await ownedNegativeBrowserSnapshot(harness, proof.cardId, ownerTag, fixture)).snapshot;
    assert.equal(proof.offscreen.browsingContextId, proof.visible.browsingContextId,
      'camera change replaced the browsing context before click');
    assert.deepEqual(proof.offscreen.worldRect, proof.visible.worldRect,
      'camera change moved or resized the Card before click');
    assert.deepEqual(proof.offscreen.geometryStyle, proof.visible.geometryStyle,
      'camera change modified Card geometry styles before click');
    for (const snapshot of [proof.observed.snapshot, proof.beforeAttempt]) {
      assert.equal(snapshot.documentId, proof.visibleObserved.snapshot.documentId,
        'camera change replaced the actor document before click');
      assert.deepEqual(snapshot.viewport, proof.visibleObserved.snapshot.viewport,
        'camera change modified the content viewport before click');
      assert.ok(snapshot.text.includes('QA click count: 0'), 'camera setup already clicked the fixture');
    }
    const target = proof.observed.snapshot.interactiveElements.find(item => item.label === 'Reveal QA details');
    assert.ok(target?.ref && target.tag === 'button' && !target.disabled, 'offscreen fixture button is unavailable');
    proof.beforeClickSurface = await ownedCameraSurfaceSnapshot(harness, proof.cardId, ownerTag);
    assert.deepEqual(proof.beforeClickSurface, proof.offscreen,
      'camera/context changed after the offscreen observation');
    proof.receipt = await unit.service.dispatch(unit.run, { tool: BROWSER_TOOL_NAMES.click,
      callId: probeId('qa-camera-click'), arguments: { cardId: proof.cardId,
        observationId: proof.observed.observationId, expectedRevision: proof.observed.snapshot.revision,
        ref: target.ref, expectedTarget: target, postcondition: { kind: 'visible-text', value: 'QA click count: 1' } } });
    proof.afterObserved = await observe();
    proof.afterAttempt = (await ownedNegativeBrowserSnapshot(harness, proof.cardId, ownerTag, fixture)).snapshot;
    proof.afterClick = await ownedCameraSurfaceSnapshot(harness, proof.cardId, ownerTag);
    proof.uiRequests = unit.trace.requests.map(item => ({ ...item }));
    proof.priorFixture = { cardId: priorCardId, ...assertNegativeNoEffect(priorFixture,
      await ownedNegativeBrowserSnapshot(harness, priorCardId, priorOwnerTag, fixture), 'camera surface-isolation') };
  } finally {
    try {
      if (unit) {
        const receipts = await unit.service.cancelRun(unit.run);
        assert.ok(receipts.some(item => item.status === 'fulfilled' && item.value?.status === 'cancelled'),
          'camera case did not cancel its synthetic run');
      }
    } finally {
      const restored = await chrome(harness, ({ camera, cardId, sourceId, ownerTag, threadId }) => {
        const api = window.__egdesk;
        try {
          const card = cardId && document.getElementById(cardId);
          if (sourceId) api.codexBridge.removeInputSource(threadId, sourceId);
          else if (card?.dataset.egdeskQaNegativeOwner === ownerTag) {
            for (const source of api.browserAgentTools.selectedSources(threadId)) {
              if (source.sourceRef?.viewId === cardId) api.codexBridge.removeInputSource(threadId, source.id);
            }
          }
        } finally { api.state.setCanvasViewportTarget(camera, { immediate: true }); }
        return { camera: { pan: { ...api.state.panTarget }, zoom: api.state.zoomTarget,
          actualPan: { ...api.state.pan }, actualZoom: api.state.zoom },
        selection: api.browserAgentTools.selectedSources(threadId).map(item =>
          ({ id: item.id, cardId: item.sourceRef.viewId, permission: item.browserToolPermission })) };
      }, { camera: saved.camera, cardId: proof.cardId, sourceId: proof.sourceId, ownerTag, threadId: thread.id });
      proof.restoredCamera = restored.camera;
      proof.selectionAfter = restored.selection;
    }
  }
  assertBrowserCameraSurfaceIsolation(proof);
  return proof;
}

async function runBrowserNegativeProbes(harness, fixture, deadlineMs, result) {
  assertTurnTimeBudget(deadlineMs);
  result.browserNegativeStage = 'fixture-preflight';
  const bService = await import('../helper/egdesk-browser-tool-runtime.mjs');
  assert.equal(typeof bService.createBrowserToolService, 'function',
    'current B Browser tool service is unavailable; no UI probes started');
  await assertBrowserFixtureServerReady(fixture);
  // Explicit fixture setup before the camera baseline. The first-use focused
  // Browser intentionally hides the Desk dock; this is not a model action.
  result.browserNegativeDeskSetup = await chrome(harness, () => ({
    enteredDesk: window.__egdesk.surface.enterDesk(),
    initialBrowserFocus: window.__egdesk.state.surface.initialBrowserFocus,
  }));
  const initial = await chrome(harness, () => ({
    cards: [...document.querySelectorAll('.egd-browser-card')].map(card =>
      ({ id: card.id, style: card.style.cssText })).sort((a, b) => a.id.localeCompare(b.id)),
  }));
  const ownerTag = probeId('lane-c-negative-owner');
  const cardId = await chrome(harness, ({ url, ownerTag }) => {
    const card = window.__egdesk.cardRuntime.openBrowserCard(url, { openMode: 'new' });
    card.dataset.egdeskQaNegativeOwner = ownerTag;
    return card.id;
  }, { url: fixture.url, ownerTag });
  result.browserNegativeOwnedCardId = cardId;
  result.browserNegativeStage = 'owned-card-actor-ready';
  await waitUntil(async () => {
    try { return await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture); }
    catch { return null; }
  }, value => value?.snapshot?.text?.includes(fixture.marker),
  { timeoutMs: 15000, intervalMs: 200 });
  const thread = await newQaThreadInVisibleChat(harness, 'QA Browser negative simulator', deadlineMs);
  const initialChat = await chatIdentity(harness);
  assert.equal(initialChat.threadId, thread.id, 'negative probe Chat focus changed');
  assert.equal(initialChat.conversationId, null, 'negative probe room already has a native conversation');
  assert.deepEqual(initialChat.runs, [], 'negative probe room already contains a provider run');
  const probeCameraBaseline = await chrome(harness, () => ({
    pan: { ...window.__egdesk.state.panTarget }, zoom: window.__egdesk.state.zoomTarget,
  }));
  const probes = [];
  const guardedActorPositiveControls = [];
  let actorPerformPositiveControl = null;
  result.browserNegativeProbeReceipts = probes;
  const bound = async permission => {
    assertBeforeDeadline(deadlineMs);
    const source = await selectOwnedProbeSource(harness, thread, cardId, ownerTag,
      permission, fixture);
    const unit = await newNegativeService(harness, thread, cardId, source, deadlineMs);
    assert.deepEqual(unit.service.specs(unit.prepared).map(item => item.name),
      permission === 'observe' ? [BROWSER_TOOL_NAMES.observe]
        : [BROWSER_TOOL_NAMES.observe, 'egdesk_browser_navigate',
          BROWSER_TOOL_NAMES.click, BROWSER_TOOL_NAMES.fill],
    'test-only B service exposed the wrong permission-bound catalog');
    const receipt = await unit.service.bind(unit.run, unit.prepared);
    assert.equal(receipt.cards?.length, 1, 'test-only B service did not bind one Card');
    assert.equal(receipt.cards[0].cardId, cardId, 'test-only B service bound another Card');
    assert.equal(unit.trace.binding?.cardEpoch, source.browserToolIdentity.cardEpoch,
      'test-only UI binding crossed Card epochs');
    return { ...unit, source };
  };
  const cancel = async unit => {
    const receipts = await unit.service.cancelRun(unit.run);
    assert.ok(receipts.some(item => item.status === 'fulfilled'
      && item.value?.status === 'cancelled'),
    'test-only B run did not receive the UI cancel tombstone');
  };
  const observe = async unit => {
    const receipt = await unit.service.dispatch(unit.run, {
      tool: BROWSER_TOOL_NAMES.observe, callId: probeId('qa-observe'),
      arguments: { cardId },
    });
    assert.equal(receipt.status, 'observed', 'test-only B service observation is unavailable');
    assert.equal(receipt.cardId, cardId, 'test-only B service observed another Card');
    assert.equal(receipt.snapshot?.url, fixture.url, 'test-only B service observed another URL');
    assert.ok(receipt.snapshot?.text?.includes(fixture.marker),
      'test-only B service observation lost the fixture marker');
    assert.ok(typeof receipt.snapshot.documentId === 'string'
      && Number.isSafeInteger(receipt.snapshot.revision) && receipt.snapshot.viewport,
    'test-only B service observation lacks actor document metadata');
    return receipt;
  };
  const fillArgs = (observed, text) => {
    const target = observed.snapshot.interactiveElements.find(item => item.label === 'QA note');
    assert.ok(target && target.tag === 'input' && target.value === '',
      'owned QA fixture has no empty harmless input');
    return { cardId, observationId: observed.observationId,
      expectedRevision: observed.snapshot.revision,
      ref: target.ref, expectedTarget: target, text,
      postcondition: { kind: 'target-value', value: text } };
  };
  const actCount = unit => unit.trace.requests.filter(item => item.kind === 'act').length;
  const directUiAct = (unit, action, guard, { deadlineMs = Date.now() + 15000 } = {}) => unit.uiDispatch({
    version: 1, requestId: probeId('qa-ui-negative'),
    runId: unit.run.runId, clientThreadId: unit.run.clientThreadId,
    cardId, targetCardEpoch: unit.source.browserToolIdentity.cardEpoch,
    deadlineMs, kind: 'act', binding: unit.trace.binding,
    action, guard,
  });
  const guardFromObserved = (observed, target) => ({
    documentId: observed.snapshot.documentId, revision: observed.snapshot.revision,
    viewport: observed.snapshot.viewport, url: observed.snapshot.url,
    focusedRef: observed.snapshot.focusedElement?.ref || null, ...(target ? { target } : {}),
  });
  const actorDenial = unit => {
    const denied = unit.trace.requests.filter(item => item.kind === 'act').at(-1);
    assert.equal(denied?.status, 'rejected', 'stale actor action was not rejected by the UI');
    assert.match(denied.error, /stale|changed|viewport/i,
      'UI actor rejection did not identify a stale document or viewport');
    return denied;
  };
  const record = (name, code, unit, extra = {}) => probes.push({ name, code,
    cardId, sourceId: unit.source.id,
    cardEpoch: unit.source.browserToolIdentity.cardEpoch,
    syntheticRunId: unit.run.runId,
    uiRequests: unit.trace.requests.map(item => ({ ...item })),
    denied: true, ownedFixtureContentUnchangedAfterDeniedAction: true,
    simulatorOnly: true, ...extra });

  // These first two requests are denied by B before any UI act request.
  result.browserNegativeStage = 'service-pre-act-denials';
  let unit = await bound('interact');
  try {
    const observed = await observe(unit);
    assert.equal(observed.status, 'observed', 'test-only B observe was not attested');
    const baseline = await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture);
    const args = fillArgs(observed, 'QA_STALE_REVISION_MUST_NOT_FILL');
    const beforeActs = actCount(unit);
    const code = await expectNegativeCode(unit.service.dispatch(unit.run, {
      tool: BROWSER_TOOL_NAMES.fill, callId: probeId('qa-stale-revision'),
      arguments: { ...args, expectedRevision: args.expectedRevision + 1 },
    }), ['BROWSER_OBSERVATION_STALE'], 'stale-revision probe');
    assert.equal(actCount(unit), beforeActs, 'stale revision reached the UI actor');
    const revisionUnchanged = assertNegativeNoEffect(baseline,
      await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture), 'stale revision');
    record('stale-revision-before-ui', code, unit, { ...revisionUnchanged, uiActRequests: 0,
      observedRevision: observed.snapshot.revision });

    for (const url of ['javascript:alert(1)', 'data:text/html,qa', 'file:///qa-denied']) {
      const deniedCode = await expectNegativeCode(unit.service.dispatch(unit.run, {
        tool: 'egdesk_browser_navigate', callId: probeId('qa-scheme'),
        arguments: { cardId, observationId: observed.observationId,
          expectedRevision: observed.snapshot.revision,
          url, postcondition: { kind: 'url', value: url } },
      }), ['INVALID_BROWSER_TOOL'], 'forbidden-scheme probe');
      assert.equal(deniedCode, 'INVALID_BROWSER_TOOL');
    }
    assert.equal(actCount(unit), beforeActs, 'forbidden schemes reached the UI actor');
    const uiScheme = await directUiAct(unit,
      { type: 'navigate', url: 'data:text/html,QA_DENIED' },
      { documentId: observed.snapshot.documentId,
        revision: observed.snapshot.revision, viewport: observed.snapshot.viewport,
        url: observed.snapshot.url,
        focusedRef: observed.snapshot.focusedElement?.ref || null });
    assert.equal(uiScheme?.status, 'rejected', 'actual UI accepted a forbidden navigation scheme');
    assert.match(String(uiScheme.error || ''), /http|navigation/i,
      'actual UI scheme denial has no bounded reason');
    const schemeUnchanged = assertNegativeNoEffect(baseline,
      await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture), 'forbidden schemes');
    record('forbidden-scheme-before-ui', 'INVALID_BROWSER_TOOL', unit,
      { ...schemeUnchanged, serviceActRequests: 0, uiProtocolActRequests: 1, uiProtocolDenied: true,
        deniedSchemes: ['javascript:', 'data:', 'file:'] });
  } finally { await cancel(unit); }

  // A controlled click changes only the newly owned fixture DOM. Reusing the
  // older B observation must fail in the real JSWindowActor before fill input.
  result.browserNegativeStage = 'actor-stale-dom';
  unit = await bound('interact');
  try {
    const observed = await observe(unit);
    const inputArgs = fillArgs(observed, 'QA_STALE_DOM_MUST_NOT_FILL');
    const button = observed.snapshot.interactiveElements.find(item => item.label === 'Reveal QA details');
    assert.ok(button?.ref && button.tag === 'button', 'owned fixture button was not observed');
    const setupBefore = await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture);
    const setup = await chrome(harness, ({ cardId, ownerTag, ref }) => {
      const card = document.getElementById(cardId);
      if (!card?.isConnected || card.dataset.egdeskQaNegativeOwner !== ownerTag)
        throw new Error('test setup escaped the owned fixture Card');
      return window.__egdesk.browserAgent.act(cardId, { type: 'click', ref }, { settleMs: 150 });
    }, { cardId, ownerTag, ref: button.ref });
    assert.equal(setup?.ok, true, 'controlled fixture-only DOM mutation did not execute');
    const changed = await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture);
    assert.equal(setupBefore.snapshot.documentId, changed.snapshot.documentId, 'positive control crossed actor documents');
    assert.equal(changed.snapshot.qaDiagnostics.performCalls, setupBefore.snapshot.qaDiagnostics.performCalls + 1,
      'controlled actor click did not advance the live perform-entry counter exactly once');
    actorPerformPositiveControl = { cardId, actorDocumentId: changed.snapshot.documentId,
      before: setupBefore.snapshot.qaDiagnostics.performCalls, after: changed.snapshot.qaDiagnostics.performCalls };
    assert.ok(changed.snapshot.revision > observed.snapshot.revision
      && changed.snapshot.text.includes('Newly revealed node'),
    'controlled fixture DOM mutation did not invalidate the prior observation');
    assert.ok(changed.snapshot.documentId === observed.snapshot.documentId
      && same(changed.snapshot.viewport, observed.snapshot.viewport),
    'stale-DOM setup also changed document or viewport');
    const code = await expectNegativeCode(unit.service.dispatch(unit.run, {
      tool: BROWSER_TOOL_NAMES.fill, callId: probeId('qa-stale-dom'), arguments: inputArgs,
    }), ['BROWSER_ACTION_UNVERIFIED'], 'stale-DOM actor probe');
    const denied = actorDenial(unit);
    const unchanged = assertNegativeNoEffect(changed,
      await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture), 'stale DOM');
    record('stale-dom-at-actor', code, unit, { ...unchanged, uiActRequests: 1,
      observedRevision: observed.snapshot.revision,
      changedRevision: changed.snapshot.revision,
      setupAlsoChangedFocusedRef: (changed.snapshot.focusedElement?.ref || null)
        !== (observed.snapshot.focusedElement?.ref || null),
      uiStatus: denied.status, uiReason: denied.error, uiRequestId: denied.requestId });
  } finally { await cancel(unit); }

  result.browserNegativeStage = 'actor-resized-viewport';
  unit = await bound('interact');
  let originalCardStyle = null;
  try {
    const observed = await observe(unit);
    const inputArgs = fillArgs(observed, 'QA_RESIZE_MUST_NOT_FILL');
    originalCardStyle = await chrome(harness, ({ cardId, ownerTag }) => {
      const card = document.getElementById(cardId);
      if (!card?.isConnected || card.dataset.egdeskQaNegativeOwner !== ownerTag)
        throw new Error('resize escaped the owned fixture Card');
      const original = { width: card.style.width, height: card.style.height };
      const width = Math.max(340, Math.round(card.getBoundingClientRect().width) - 93);
      card.style.width = `${width}px`;
      return original;
    }, { cardId, ownerTag });
    const resized = await waitUntil(async () =>
      ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture),
    value => browserViewportChanged(observed.snapshot.viewport, value?.snapshot?.viewport),
    { timeoutMs: 10000, intervalMs: 200 });
    assert.ok(resized.snapshot.documentId === observed.snapshot.documentId
      && same(resized.snapshot.text, observed.snapshot.text)
      && (resized.snapshot.focusedElement?.ref || null)
        === (observed.snapshot.focusedElement?.ref || null),
    'resize setup also changed document, DOM text or keyboard focus');
    const code = await expectNegativeCode(unit.service.dispatch(unit.run, {
      tool: BROWSER_TOOL_NAMES.fill, callId: probeId('qa-resize'), arguments: inputArgs,
    }), ['BROWSER_ACTION_UNVERIFIED'], 'resized-viewport actor probe');
    const denied = actorDenial(unit);
    const unchanged = assertNegativeNoEffect(resized,
      await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture), 'resized viewport');
    record('resized-viewport-at-actor', code, unit, { ...unchanged, uiActRequests: 1,
      observedViewport: observed.snapshot.viewport, resizedViewport: resized.snapshot.viewport,
      uiStatus: denied.status, uiReason: denied.error, uiRequestId: denied.requestId });
  } finally {
    await cancel(unit);
    if (originalCardStyle) await chrome(harness, ({ cardId, ownerTag, original }) => {
      const card = document.getElementById(cardId);
      if (!card?.isConnected || card.dataset.egdeskQaNegativeOwner !== ownerTag)
        throw new Error('resize restore escaped the owned fixture Card');
      card.style.width = original.width; card.style.height = original.height;
      return true;
    }, { cardId, ownerTag, original: originalCardStyle });
  }

  result.browserNegativeStage = 'observe-permission-denial';
  unit = await bound('observe');
  try {
    const observed = await observe(unit);
    const baseline = await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture);
    const button = observed.snapshot.interactiveElements.find(item => item.label === 'Reveal QA details');
    assert.ok(button?.ref && button.tag === 'button', 'observe-only fixture button is unavailable');
    const beforeActs = actCount(unit);
    const code = await expectNegativeCode(unit.service.dispatch(unit.run, {
      tool: BROWSER_TOOL_NAMES.click, callId: probeId('qa-escalation'),
      arguments: { cardId, observationId: observed.observationId,
        expectedRevision: observed.snapshot.revision, ref: button.ref,
        expectedTarget: button, postcondition: { kind: 'visible-text', value: 'Newly revealed node' } },
    }), ['BROWSER_INTERACTION_NOT_GRANTED'], 'observe-to-interact escalation');
    assert.equal(actCount(unit), beforeActs, 'observe-only escalation reached the UI actor');
    const uiEscalation = await directUiAct(unit,
      { type: 'click', ref: button.ref },
      { documentId: observed.snapshot.documentId,
        revision: observed.snapshot.revision, viewport: observed.snapshot.viewport,
        url: observed.snapshot.url, focusedRef: observed.snapshot.focusedElement?.ref || null,
        target: button });
    assert.equal(uiEscalation?.status, 'rejected',
      'actual UI accepted an observe-only interaction escalation');
    assert.match(String(uiEscalation.error || ''), /interaction was not selected/i,
      'actual UI permission denial has no bounded reason');
    const unchanged = assertNegativeNoEffect(baseline,
      await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture), 'observe-only escalation');
    record('observe-only-interaction-denied', code, unit, { ...unchanged, serviceActRequests: 0,
      uiProtocolActRequests: 1, uiProtocolDenied: true, selectedPermission: 'observe' });
  } finally { await cancel(unit); }

  result.browserNegativeStage = 'stop-before-first-bind';
  const stopSource = await selectOwnedProbeSource(harness, thread, cardId, ownerTag,
    'interact', fixture);
  unit = await newNegativeService(harness, thread, cardId, stopSource, deadlineMs,
    { holdFirstBind: true });
  unit.source = stopSource;
  const stoppedBaseline = await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture);
  const binding = unit.service.bind(unit.run, unit.prepared);
  try {
    await waitUntil(() => unit.trace.heldBindRequest, Boolean,
      { timeoutMs: 5000, intervalMs: 50 });
    const cancelled = await unit.service.cancelRun(unit.run);
    assert.ok(cancelled.some(item => item.status === 'fulfilled'
      && item.value?.status === 'cancelled'),
    'stop-before-bind did not install the actual UI cancel tombstone');
    unit.trace.releaseBind();
    const code = await expectNegativeCode(binding,
      ['BROWSER_BINDING_STALE', 'BROWSER_RUN_ENDED'], 'late first bind');
    assert.ok(unit.trace.requests.some(item => item.kind === 'bind' && item.status === 'rejected'),
      'late first bind was not denied by the actual UI protocol');
    const requestsBeforeAfterStop = unit.trace.requests.length;
    await expectNegativeCode(unit.service.dispatch(unit.run, {
      tool: BROWSER_TOOL_NAMES.observe, callId: probeId('qa-after-stop'),
      arguments: { cardId },
    }), ['BROWSER_RUN_ENDED'], 'observe after stop');
    assert.equal(unit.trace.requests.length, requestsBeforeAfterStop,
      'stopped synthetic run sent a new UI request');
    const unchanged = assertNegativeNoEffect(stoppedBaseline,
      await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture), 'stop-before-bind');
    record('stop-before-first-bind-accept', code, unit,
      { ...unchanged, uiActRequests: 0, cancelledBeforeBindAccepted: true });
  } finally {
    try { await unit.service.cancelRun(unit.run); } finally { unit.trace.releaseBind?.(); }
  }

  result.browserNegativeStage = 'expired-request-before-actor';
  unit = await bound('interact');
  try {
    const observed = await observe(unit);
    const args = fillArgs(observed, 'QA_EXPIRED_MUST_NOT_FILL');
    const baseline = await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture);
    const response = await directUiAct(unit, { type: 'fill', ref: args.ref, text: args.text },
      guardFromObserved(observed, args.expectedTarget), { deadlineMs: Date.now() - 1 });
    assert.equal(response?.status, 'rejected', 'actual UI accepted an expired request');
    assert.match(String(response.error || ''), /expired/i, 'expired request lacks the actual UI denial reason');
    const denied = unit.trace.requests.at(-1);
    assert.ok(denied.kind === 'act' && denied.deadlineMs <= denied.attemptedAt, 'probe was not expired at the UI');
    const unchanged = assertNegativeNoEffect(baseline,
      await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture), 'expired request');
    record('expired-request-before-actor', null, unit, { ...unchanged, uiActRequests: 1,
      uiStatus: response.status, uiReason: denied.error, uiRequestId: denied.requestId,
      requestDeadlineMs: denied.deadlineMs, attemptedAt: denied.attemptedAt });
  } finally { await cancel(unit); }

  result.browserNegativeStage = 'cancel-before-act';
  unit = await bound('interact');
  try {
    const observed = await observe(unit);
    const args = fillArgs(observed, 'QA_CANCELLED_MUST_NOT_FILL');
    const baseline = await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture);
    await cancel(unit);
    const cancelReceipt = unit.trace.requests.filter(item => item.kind === 'cancel').at(-1);
    assert.equal(cancelReceipt?.status, 'cancelled', 'owned UI cancel tombstone was not observed');
    const response = await directUiAct(unit, { type: 'fill', ref: args.ref, text: args.text },
      guardFromObserved(observed, args.expectedTarget));
    assert.equal(response?.status, 'rejected', 'actual UI accepted a cancelled request');
    assert.match(String(response.error || ''), /cancelled/i, 'cancelled request lacks the actual UI denial reason');
    const denied = unit.trace.requests.at(-1);
    assert.ok(cancelReceipt.respondedAt <= denied.attemptedAt, 'action preceded its cancellation acknowledgement');
    const requestsBeforeService = unit.trace.requests.length;
    const code = await expectNegativeCode(unit.service.dispatch(unit.run, {
      tool: BROWSER_TOOL_NAMES.fill, callId: probeId('qa-cancelled-service'), arguments: args,
    }), ['BROWSER_RUN_ENDED'], 'service action after cancellation');
    assert.equal(unit.trace.requests.length, requestsBeforeService, 'cancelled B service dispatched a new UI request');
    const unchanged = assertNegativeNoEffect(baseline,
      await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture), 'cancel before act');
    record('cancel-before-act', code, unit, { ...unchanged, uiActRequests: 1,
      serviceActRequestsAfterCancel: 0, uiStatus: response.status, uiReason: denied.error,
      uiRequestId: denied.requestId, attemptedAt: denied.attemptedAt,
      cancelReceipt: { requestId: cancelReceipt.requestId, runId: cancelReceipt.runId,
        cardId: cancelReceipt.cardId, status: cancelReceipt.status, at: cancelReceipt.respondedAt } });
  } finally { await cancel(unit); }

  // Each action uses a new current-turn selection/binding and a fresh B
  // observation. Unlike the older stale-DOM setup click, these are guarded.
  result.browserNegativeStage = 'guarded-actor-positive-controls';
  for (const action of ['fill', 'click']) {
    unit = await bound('interact');
    try {
      const observed = await observe(unit);
      const before = await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture);
      const target = observed.snapshot.interactiveElements.find(item =>
        item.label === (action === 'fill' ? 'QA note' : 'Reveal QA details'));
      assert.ok(target?.ref && target.disabled === false, 'guarded positive fixture target is unavailable');
      const arguments_ = action === 'fill' ? fillArgs(observed, 'QA_GUARDED_FILL_CONTROL')
        : { cardId, observationId: observed.observationId, expectedRevision: observed.snapshot.revision,
          ref: target.ref, expectedTarget: target,
          postcondition: { kind: 'visible-text', value: 'QA click count: 2' } };
      const receipt = await unit.service.dispatch(unit.run, {
        tool: BROWSER_TOOL_NAMES[action], callId: probeId(`qa-guarded-${action}`), arguments: arguments_,
      });
      const afterObserved = await observe(unit);
      const after = await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture);
      guardedActorPositiveControls.push({ action, cardId, simulatorOnly: true,
        sourceId: unit.source.id, cardEpoch: unit.source.browserToolIdentity.cardEpoch,
        syntheticRunId: unit.run.runId, observed, afterObserved, receipt,
        beforeAttempt: before.snapshot, afterAttempt: after.snapshot,
        uiRequests: unit.trace.requests.map(item => ({ ...item })) });
    } finally { await cancel(unit); }
  }

  // B rejects disabled targets before sending UI input. Bypass only B's target
  // precheck, not the current selection, UI binding, observed guard or Child.
  // The readonly/fieldset/ancestor setup is static fixture content, never chrome DOM mutation.
  result.browserNegativeStage = 'child-noneditable-target-denials';
  for (const spec of CHILD_TARGET_PROBES) {
    unit = await bound('interact');
    try {
      const observed = await observe(unit);
      const target = observed.snapshot.interactiveElements.find(item => item.label === spec.label);
      assert.ok(target?.ref && target.tag === 'input' && target.value === ''
        && target.disabled === spec.disabled, `${spec.name} fixture setup is not present`);
      const before = await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture);
      const response = await directUiAct(unit,
        { type: 'fill', ref: target.ref, text: 'QA_CHILD_DENIAL_MUST_NOT_FILL' },
        guardFromObserved(observed, target));
      assert.equal(response?.status, 'rejected', `${spec.name} unexpectedly succeeded`);
      const denied = unit.trace.requests.at(-1);
      assert.match(denied.error, spec.reason, `${spec.name} did not reach the intended Child guard`);
      assertProbeActionDiagnostic(denied, cardId, 'actor', 'rejected');
      const unchanged = assertNegativeNoEffect(before,
        await ownedNegativeBrowserSnapshot(harness, cardId, ownerTag, fixture), spec.name);
      record(spec.name, null, unit, { ...unchanged, uiActRequests: 1,
        uiStatus: response.status, uiReason: denied.error, uiRequestId: denied.requestId });
    } finally { await cancel(unit); }
  }

  result.browserNegativeStage = 'camera-surface-isolation';
  const cameraSurfaceIsolation = await runBrowserCameraSurfaceIsolation(
    harness, fixture, deadlineMs, thread, cardId, ownerTag, result);

  const final = await chrome(harness, initialCards => ({
    cards: initialCards.map(item => {
      const card = document.getElementById(item.id);
      return { id: item.id, style: card?.style.cssText ?? null };
    }),
    pan: { ...window.__egdesk.state.panTarget }, zoom: window.__egdesk.state.zoomTarget,
  }), initial.cards);
  assert.deepEqual(final.cards, initial.cards,
    'test-only Browser probes changed a preexisting Browser Card');
  assert.ok(same(final.pan, probeCameraBaseline.pan)
    && final.zoom === probeCameraBaseline.zoom,
    'test-only Browser probes moved the Canvas camera');
  const finalChat = await chatIdentity(harness);
  assert.equal(finalChat.threadId, thread.id, 'negative probe switched Chat threads');
  assert.equal(finalChat.conversationId, null, 'negative probe created a native conversation');
  assert.deepEqual(finalChat.runs, [], 'negative probe started a native provider run');
  const proof = { simulatorOnly: true, nativeModelOriginVerified: false,
    providerTurns: 0, actorPhysicalDispatchCounterVerified: false,
    actorPerformCounterVerified: true, actorPerformPositiveControl,
    cardId, fixture: { url: fixture.url, marker: fixture.marker }, probes, guardedActorPositiveControls,
    cameraSurfaceIsolation,
    requestsScopedToOwnedCard: true,
    preexistingBrowserCardStylesUnchanged: true, canvasPanZoomUnchanged: true };
  assertBrowserNegativeProbeResults(proof);
  result.browserNegativeStage = 'all-denials-verified-test-only';
  return proof;
}

async function main() {
  const deadlineMs = parseDeadlineUtc(required(option('--deadline-utc'), '--deadline-utc is required for real runs'));
  const cases = parseCases(required(option('--cases'), '--cases is required for real runs'));
  const resumeEmptyThreadId = parseResumeEmptyThreadId(option('--resume-empty-thread-id'), cases);
  const resumeSource = parseResumeSourceOptions({ threadId: option('--resume-source'),
    root: option('--resume-source-root'), sourceId: option('--resume-source-id'),
    originalHash: option('--resume-source-original-sha256') }, cases, resumeEmptyThreadId);
  if (cases.includes('browser-negative')) assert.deepEqual(cases, ['browser-negative'],
    'Browser simulator probes must run separately from provider cases');
  const browserFixture = cases.includes('browser') || cases.includes('browser-negative')
    ? assertBrowserFixtureConfig(
      required(option('--browser-fixture-url'), '--browser-fixture-url is required for Browser QA'),
      required(option('--browser-fixture-marker'), '--browser-fixture-marker is required for Browser QA'))
    : null;
  const profile = required(option('--profile', process.env.EGDESK_FIREFOX_PROFILE), '--profile is required');
  assertBeforeDeadline(deadlineMs);
  assertQaAttachMode(cases);
  await runUiFlow('native-tool-flow-real-chat', async ({ harness, check, result }) => {
    result.realExecutionVerified = false;
    result.selectedRealExecutionVerified = false;
    result.requestedCases = cases;
    result.completedCases = [];
    result.providerTurns = [];
    assertBeforeDeadline(deadlineMs);
    const manifest = assertQaFixtureManifest(profile);
    check('dedicated real-turn fixture cwd exists', !!manifest.realTurnCwd);
    assertBeforeDeadline(deadlineMs);
    if (cases.includes('browser-negative')) {
      result.kind = 'browser-negative-test-only-simulator';
      result.browserNegativeAuthority = 'test-only-synthetic-B-service-and-owned-UI';
      result.nativeModelOriginVerified = false;
      result.providerTurn = 'not-run-test-only-simulator';
      const health = await loopbackJson('/health');
      const state = () => loopbackJson('/__qa/state', { token: process.env.EGDESK_QA_FIXTURE_TOKEN });
      result.browserNegativeBackendBefore = assertNegativeFixtureBackend(profile, health, await state());
      try {
        result.browserNegative = await runBrowserNegativeProbes(harness, browserFixture, deadlineMs, result);
        result.browserNegativeDomProbeProofVerified = true;
        result.browserNegativeVisual = await captureBrowserNegativeScreenshot(harness, cases);
        result.visualPass = null; // A screenshot, even when available, is not a visual review.
        if (result.browserNegativeVisual.path) result.screenshots.push(result.browserNegativeVisual.path);
        if (result.browserNegativeVisual.status === 'unsupported') result.visualReview = 'unsupported-headless';
      } finally {
        result.browserNegativeBackendAfter = assertNegativeFixtureBackend(profile, await loopbackJson('/health'), await state());
      }
      result.completedCases.push('browser-negative');
      Object.assign(result, scenarioCoverage(cases, result.completedCases));
      result.realExecutionVerified = false;
      result.providerTurn = 'not-run-test-only-simulator';
      return;
    }
    const bridge = await assertBridgePreflight();
    const nativeContractFingerprint = assertNativeQaCapabilityBeforeTurn(bridge.health);
    const qaCwd = resumeSource
      ? existingQaRunDirectory(manifest.realTurnCwd, resumeSource.root)
      : createQaRunDirectory(manifest.realTurnCwd);
    const fixtures = resumeSource ? null : makeFixtures(qaCwd);
    result.qaFixtureRoot = qaCwd;

    if (cases.includes('native')) {
    const nativeThread = await newQaThreadInVisibleChat(harness, 'QA native read and command', deadlineMs);
    const reflected = await reflectedOrdinaryRequest(harness, nativeThread, qaCwd);
    assertOrdinaryUiBaseline(reflected, qaCwd);
    check('normal Chat composer remains ordinary before scoped QA fetch instrumentation', true);
    const nativeBefore = fileInventory(qaCwd);
    const readCommand = nativeReadCommand(fixtures.nativeFile);
    const printfCommand = harmlessPrintfCommand(fixtures.commandTag);
    const nativePrompt = `Read the public local QA file using exactly this native command: ${readCommand}. Separately run exactly this harmless command: ${printfCommand}. In the answer report the exact marker read from the file and the command's output marker. Do not write files, use network, or open other paths.`;
    assertHiddenMarkerOutsideModelAdmission({ marker: fixtures.nativeNonce,
      message: nativePrompt, title: nativeThread.title, path: fixtures.nativeFile, metadata: reflected });
    check('random file-content nonce is absent from model-facing pre-admission data', true);
    const native = await completedUiRun(harness, nativeThread, nativePrompt, deadlineMs,
      { cwd: qaCwd, sourceIds: [],
        qaOutputMarkers: [fixtures.nativeNonce, fixtures.commandTag] });
    const nativeTurn = { case: 'native', runId: native.run.runId, status: 'completed', evidence: 'unverified' };
    result.providerTurns.push(nativeTurn);
    result.providerTurn = 'real-codex-completed-unverified';
    assertNativeAuthorityChain({ ...native, cwd: qaCwd });
    const nativeProof = assertNativeFileAndCommand({ ...native,
      nativeFile: fixtures.nativeFile, nonce: fixtures.nativeNonce, commandTag: fixtures.commandTag, readCommand,
      nativeContractFingerprint, beforeFiles: nativeBefore, afterFiles: fileInventory(qaCwd) });
    result.native = { runId: native.run.runId, ...nativeProof };
    nativeTurn.evidence = 'verified';
    result.completedCases.push('native');
    }

    if (cases.includes('source')) {
    assertBeforeDeadline(deadlineMs);
    const sourcePrompt = 'Use the attached immutable public QA source with egdesk_read_source. Report its original marker exactly. Do not read the current live file, write files, use network, or perform other work.';
    result.sourceStage = resumeSource ? 'prepared-draft-resume-requested'
      : resumeEmptyThreadId ? 'resume-requested' : 'new-thread-requested';
    const prepared = resumeSource
      ? await resumePreparedSourceDraft(harness, resumeSource, qaCwd,
        sourcePrompt, deadlineMs, result) : null;
    const sourceThread = prepared?.thread || (resumeEmptyThreadId
      ? await resumeConfirmedEmptySourceThread(harness, resumeEmptyThreadId,
        'QA immutable source read', deadlineMs, result)
      : await newSourceQaThreadWithReceipts(harness,
        'QA immutable source read', deadlineMs, result));
    const sourceFile = path.join(qaCwd, 'source-read.txt');
    const reference = prepared?.reference || await captureImmutableSource(harness,
      sourceThread, sourceFile, deadlineMs, result);
    const originalHash = prepared?.originalHash || sha256(fs.readFileSync(sourceFile));
    check('production source capture binds original file bytes', reference.hash === originalHash);
    if (!prepared) {
      assertBeforeDeadline(deadlineMs);
      fs.writeFileSync(sourceFile, `Public EG-Desk changed live QA source.\n${fixtures.changedNonce}\n`, { flag: 'w', mode: 0o600 });
      result.sourceStage = 'owned-live-file-changed';
    }
    const currentHash = prepared?.currentHash || sha256(fs.readFileSync(sourceFile));
    const originalNonce = prepared?.originalNonce || fixtures.sourceNonce;
    const changedNonce = prepared?.changedNonce || fixtures.changedNonce;
    const reflectedSource = await reflectedOrdinaryRequest(harness, sourceThread, qaCwd, [reference.sourceId]);
    assertOrdinaryUiBaseline(reflectedSource, qaCwd);
    check('normal Chat baseline retains the selected immutable source',
      same(reflectedSource.contextSnapshotIds, [reference.sourceId]));
    assertHiddenMarkerOutsideModelAdmission({ marker: originalNonce,
      message: sourcePrompt, title: sourceThread.title, path: sourceFile, metadata: reflectedSource });
    const sourceBefore = fileInventory(qaCwd);
    result.sourceStage = 'source-send-requested';
    const source = await completedUiRun(harness, sourceThread, sourcePrompt,
      deadlineMs, { cwd: qaCwd, sourceIds: [reference.sourceId], hiddenMarker: originalNonce,
        ...(prepared ? { preparedSource: { sourceId: reference.sourceId, result } } : {}) });
    const sourceTurn = { case: 'source', runId: source.run.runId, status: 'completed', evidence: 'unverified' };
    result.providerTurns.push(sourceTurn);
    result.providerTurn = 'real-codex-completed-unverified';
    assert.equal(source.emitted.hiddenMarkerAbsentFromModelAdmission, true,
      'original source marker leaked before the production Chat fetch');
    assertNativeAuthorityChain({ ...source, cwd: qaCwd });
    const sourceProof = assertSourceRead({ ...source, reference,
      originalNonce, changedNonce, originalHash, currentHash,
      stored: await storedSource(harness, sourceThread, reference),
      beforeFiles: sourceBefore, afterFiles: fileInventory(qaCwd),
      changedFile: sourceFile });
    result.source = { runId: source.run.runId, ...sourceProof };
    sourceTurn.evidence = 'verified';
    result.completedCases.push('source');
    result.sourceStage = 'source-evidence-verified';
    }

    if (cases.includes('browser')) {
    assertBeforeDeadline(deadlineMs);
    await assertBrowserFixtureServerReady(browserFixture);
    await browserRootSseReceiptBeforeTurn(harness, deadlineMs);
    const cards = await createBrowserCards(harness, browserFixture.url, deadlineMs);
    await waitUntil(async () => {
      try { return await browserSnapshot(harness, cards.targetCardId, cards.controlCardId); }
      catch { return null; }
    }, value => value?.targetSegments?.includes(browserFixture.marker), { timeoutMs: 15000 });
    const browserThread = await newQaThreadInVisibleChat(harness, 'QA local Browser tools', deadlineMs);
    const selection = await selectBrowserInteraction(harness, browserThread, cards.targetCardId, deadlineMs);
    check('B UI explicitly selected only the local QA card for interaction', selection.cardId === cards.targetCardId
      && selection.selectedByUser === true && selection.permission === 'interact');
    await browserExecutionAuthorityBeforeTurn(harness, browserThread, selection,
      bridge.health, qaCwd, deadlineMs);
    await ensureVisibleChatComposer(harness, deadlineMs);
    const before = await browserSnapshot(harness, cards.targetCardId, cards.controlCardId);
    const browserRootReady = await browserRootSseReceiptBeforeTurn(harness, deadlineMs);
    const browserBefore = fileInventory(qaCwd);
    const fillValue = 'harmless QA input';
    const browser = await completedUiRun(harness, browserThread,
      `Use EG-Desk Browser model tools only on selected local QA card ${cards.targetCardId}. Observe first, then include the exact fixture marker you observed in your final answer. Click the "Reveal QA details" button using its exact observed target and a visible-text postcondition of "Newly revealed node". Re-observe the changed page, then fill the "QA note" text input with ${JSON.stringify(fillValue)} using its exact observed target and a target-value postcondition. Use only observe, click, observe, fill in this run. Do not navigate, submit forms, use accounts, commands, other cards or websites.`,
      deadlineMs, { cwd: qaCwd, sourceIds: null,
        policyMode: 'browserBounded', browserSelection: selection, browserRootReady,
        browserFixtureUrl: browserFixture.url });
    const browserTurn = { case: 'browser', runId: browser.run.runId, status: 'completed', evidence: 'unverified' };
    result.providerTurns.push(browserTurn);
    result.providerTurn = 'real-codex-completed-unverified';
    const after = await browserSnapshot(harness, cards.targetCardId, cards.controlCardId);
    result.browserFocusTrace = {
      beforeCardSnapshot: { sampledAtMs: before.sampledAtMs,
        activeEntityId: before.camera.activeEntityId, focusedBrowserCardId: before.focusedCardId },
      beforeSend: { sampledAtMs: browser.preSendFocus?.sampledAtMs ?? null,
        activeEntityId: browser.preSendFocus?.activeEntityId ?? null,
        focusedBrowserCardId: browser.preSendFocus?.focusedBrowserCardId ?? null },
      originalFetch: { sampledAtMs: browser.emitted.focusAtOriginalFetch?.sampledAtMs ?? null,
        activeEntityId: browser.emitted.focusAtOriginalFetch?.activeEntityId ?? null,
        chatCardEntityId: browser.emitted.focusAtOriginalFetch?.chatCardEntityId ?? null,
        focusedBrowserCardId: browser.emitted.focusAtOriginalFetch?.focusedBrowserCardId ?? null },
      afterModel: { sampledAtMs: after.sampledAtMs,
        activeEntityId: after.camera.activeEntityId, focusedBrowserCardId: after.focusedCardId,
        activeElementId: after.activeElementId, activeElementTag: after.activeElementTag },
    };
    const browserProof = assertBrowserPositiveFlow({ ...browser, cwd: qaCwd, selection,
      expectedPolicyMode: 'browserBounded',
      fixture: browserFixture,
      target: { cardId: cards.targetCardId, profileId: selection.profileId, fillValue },
      control: { cardId: cards.controlCardId }, before, after });
    assertNoFixtureWrites(browserBefore, fileInventory(qaCwd));
    const renderedProof = await renderedBrowserAnswer(harness, browserThread,
      browser.run, browserFixture, deadlineMs);
    result.screenshots.push(await harness.screenshot('browser-model-final-chat'));
    result.browser = { runId: browser.run.runId, ...browserProof, ...renderedProof };
    browserTurn.evidence = 'verified-local-fixture-positive';
    result.browserNegativeGuardStatus = 'not-run';
    result.browserNegativeGuardReason = 'native-model-negative-adapter-unavailable';

    result.completedCases.push('browser');
    }

    const coverage = scenarioCoverage(cases, result.completedCases);
    Object.assign(result, coverage);
    // This flag is scoped to the explicitly selected real-provider cases.
    // fullScenarioVerified remains false while the native-negative adapter
    // is absent; browser-negative never reaches this provider-only branch.
    result.selectedRealExecutionVerified = coverage.selectedCasesVerified;
    result.realExecutionVerified = result.selectedRealExecutionVerified;
    result.realExecutionScope = 'selected-cases';
    result.verifiedRealCases = [...result.completedCases];
    result.nativeModelOriginVerified = result.selectedRealExecutionVerified;
    result.providerTurn = coverage.fullScenarioVerified
      ? 'full-scenario-evidence-verified' : 'selected-cases-evidence-verified-partial';
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const servingFixture = process.argv.includes('--serve-browser-fixture');
  try { if (servingFixture) await serveBrowserFixture(); else await main(); }
  catch (error) {
    process.exitCode = 1;
    process.stdout.write(`${JSON.stringify({ kind: servingFixture ? 'egdesk-browser-qa-fixture' : 'native-tool-flow-real-chat', automatedAssertionsPassed: false,
      realExecutionVerified: false, providerTurn: 'not-run', error: error.message })}\n`);
  }
}
