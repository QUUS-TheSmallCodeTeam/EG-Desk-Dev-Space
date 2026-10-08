#!/usr/bin/env node
// Lane C: real EG-Desk Chat tool-flow QA. The CLI is intentionally fail-closed
// until ordinary UI bounded-policy/nonce routing and B's public receipts are wired.
// Importing this module is pure; only an explicit CLI invocation touches runtime.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { chatIdentity, chrome, loopbackJson, newQaThread, observeChatEvents, option, runUiFlow, selectorForId,
  sendFromComposer, waitUntil } from './egdesk-qa-ui-flow.mjs';

const BROWSER_TOOL_NAMES = Object.freeze({ observe: 'egdesk_browser_observe',
  click: 'egdesk_browser_click', fill: 'egdesk_browser_fill' });
const QA_CASES = Object.freeze(['native', 'source', 'browser']);
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
  '--cases must be a comma-separated unique subset of native,source,browser');
  return cases;
}

export function scenarioCoverage(requestedCases, completedCases) {
  assert.ok(Array.isArray(requestedCases) && Array.isArray(completedCases), 'case coverage needs explicit lists');
  const selectedCasesVerified = requestedCases.every(item => completedCases.includes(item));
  const fullScenarioVerified = selectedCasesVerified && QA_CASES.every(item => requestedCases.includes(item));
  return { selectedCasesVerified, fullScenarioVerified,
    coverage: fullScenarioVerified ? 'full' : 'partial' };
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
  assert.notEqual(health?.fixture, true, 'fixture helper cannot prove a real turn');
  assert.equal(auth?.isLoggedIn, true, 'existing provider authentication is not ready');
  assert.notEqual(auth?.loginInProgress, true, 'authentication is changing');
  assert.equal(fixtureEndpointStatus, 404, 'fixture control endpoint is exposed');
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
  const capture = (run.context?.captures || []).find(item => item.sourceId === reference.sourceId);
  assert.ok(capture && capture.hash === originalHash, 'run lacks the original immutable source binding');
  assert.equal(stored?.capture?.sourceId, reference.sourceId, 'inspector source ID differs');
  assert.equal(stored?.capture?.hash, originalHash, 'inspector capture hash differs');
  assert.ok(stored?.source?.text?.includes(originalNonce), 'immutable inspector lacks original nonce');
  assert.ok(!stored.source.text.includes(changedNonce), 'immutable capture became live-file contents');
  assert.ok(!(run.activities || []).some(item => item.kind === 'commandExecution'),
    'custom-source turn also used a native command; source-read evidence is not distinct');
  const named = (run.activities || []).filter(item => item.kind === 'dynamicToolCall'
    && item.detail?.tool === 'egdesk_read_source' && item.status === 'completed');
  const read = events.find(event => event.event === 'context.read.completed'
    && event.runId === run.runId && event.details?.sourceId === reference.sourceId
    && event.details?.deliveryStatus === 'sent-to-app-server' && event.details?.receiptId
    && named.some(item => item.id === event.itemId));
  assert.ok(read, 'named native egdesk_read_source call and delivered packet receipt are missing');
  const packet = (run.context?.packets || []).find(item => item.receiptId === read.details.receiptId
    && item.sourceId === reference.sourceId && item.packetId === read.details.packetId);
  assert.ok(packet, 'run packet is not bound to source, native call and delivery receipt');
  assert.ok(['direct', 'reader'].includes(packet.mode) && packet.mode === read.details.mode
    && packet.coverage && packet.coverage.sourceTruncated === false,
  'SmartRead admission/coverage is unavailable or truncated');
  assert.equal(stored?.delivered?.packetId, packet.packetId, 'immutable inspector has no matching delivered packet');
  assert.equal(stored?.delivered?.deliveryStatus, 'sent-to-app-server', 'inspector packet was not delivered');
  const answer = (run.messages || []).filter(item => item.role === 'assistant').map(item => item.text || '').join('\n');
  assert.ok(answer.includes(originalNonce) && !answer.includes(changedNonce),
    'answer did not distinguish immutable original from changed live file');
  return { sourceId: reference.sourceId, nativeCallId: read.itemId,
    packetId: read.details.packetId, readMode: packet.mode };
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
  assert.equal(after.targetInputFocused, true, 'filled input did not retain target-card focus');
  assert.notEqual(after.focusedCardId, control.cardId, 'Browser action focused the wrong card');
  assert.equal(before.controlText, after.controlText, 'wrong-card DOM changed');
  assert.equal(before.controlInputValue, after.controlInputValue, 'wrong-card input changed');
  assert.equal(control.cardId, before.controlCardId, 'control card identity was not observed');
  assert.ok(same(before.camera, after.camera), 'Browser tool moved Canvas pan/zoom');
  assert.ok(same(before.cards, after.cards), 'Browser tool opened/closed or reordered cards');
  return { cardId: target.cardId, observeItemId: observeBefore.itemId,
    clickItemId: click.itemId, staleItemId: stale.itemId, fillItemId: fill.itemId };
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
export function assertBrowserUiRequest(reflection, { cwd, clientThreadId, conversationId = null, selection }) {
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
  assert.equal(reflection?.executionPolicy?.mode, 'fixtureBrowserQa',
    'Browser write action lacks A bounded native execution policy');
  assert.ok(typeof reflection?.browserTransportId === 'string' && reflection.browserTransportId,
    'Browser QA request has no live UI transport binding');
  assert.equal(reflection?.selectedSources?.length, 1, 'Browser QA request must select exactly one card');
  const source = reflection.selectedSources[0];
  assert.equal(source.kind, 'browser', 'Browser QA selected a non-Browser source');
  assert.equal(source.sourceId, selection.sourceId, 'Browser QA request selected another source');
  assert.equal(source.cardId, selection.cardId, 'Browser QA request selected another card');
  assert.equal(source.profileId, selection.profileId, 'Browser QA request selected another profile');
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
  assert.equal(ready?.eventSourceReadyState, 1, 'root Browser SSE is not OPEN');
  assert.ok(typeof ready?.browserTransportId === 'string' && ready.browserTransportId,
    'root SSE ready event has no Browser transport ID');
  assert.ok(Number.isFinite(ready?.observedAt) && ready.observedAt <= now
    && now - ready.observedAt <= 5000, 'root SSE Browser transport observation is stale');
  if (emitted) assert.equal(emitted.browserTransportId, ready.browserTransportId,
    'Chat send did not use this fresh root SSE Browser transport');
  return true;
}

async function browserRootSseReceiptBeforeTurn(harness) {
  const ready = await chrome(harness, () => {
    const status = window.__egdesk?.browserAgentTools?.rootSseReady?.();
    if (!status) return null;
    return { sourceReady: status.sourceReady === true,
      eventSourceReadyState: status.eventSourceReadyState,
      browserTransportId: status.browserTransportId || null,
      observedAt: Date.now() };
  });
  assertFreshBrowserRootSse({ ready });
  return ready;
}

async function browserExecutionAuthorityBeforeTurn(harness, thread, selection, health, cwd,
  expectedConversationId = null) {
  assertNativeQaCapabilityBeforeTurn(health);
  const reflected = await reflectedOrdinaryRequest(harness, thread, cwd, [], { allowExisting: true });
  assertOrdinaryUiBaseline(reflected, cwd);
  assert.equal(reflected.conversationId || null, expectedConversationId,
    'Browser Chat baseline targets another native conversation');
  assert.equal(selection?.selectedByUser, true, 'Browser Card was not selected through the UI');
  assert.equal(selection?.permission, 'interact', 'Browser Card lacks an explicit interact selection');
  return browserRootSseReceiptBeforeTurn(harness);
}

// Integration seam B: retrieve public model-invoked Browser dynamic-tool
// receipts. A direct browserAgent.snapshot/act call is never tool-call proof.
async function browserToolReceipts(_run) {
  throw new Error('B Browser model-tool receipt adapter is not wired');
}

// Integration seam B/Main: issue only owned QA fixture guard probes against
// the selected Card after its native run is stopped/cancelled. Capture live UI
// request IDs, status, actor-dispatch counter and before/after DOM. B's pure
// tests do not substitute for these live receipts.
async function browserNegativeGuardReceipts(_harness, _run, _selection) {
  throw new Error('live B DOM/viewport/expiry/cancel guard receipt adapter is not wired');
}

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
        permission: source.browserToolPermission || null, selectedByUser: source.selectedByUser === true,
        cardEpoch: source.browserToolIdentity?.cardEpoch || null,
        hasOneTimeToken: typeof source.browserToolSelection?.token === 'string'
          && !!source.browserToolSelection.token,
        tokenThreadId: source.browserToolSelection?.threadId || null })),
      personaFields: ['agentProfile', 'systemPrompt', 'toolMode'].filter(field => Object.hasOwn(request, field)) };
  }, { threadId: thread.id, cwd, sourceIds, allowExisting });
}

async function installQaSendInterceptor(harness, expected) {
  return chrome(harness, expected => {
    if (window.__egdeskQaSendInterceptor) throw new Error('QA Chat fetch interceptor is already installed');
    const route = 'http://127.0.0.1:39218/chat/send';
    const original = window.fetch;
    if (typeof original !== 'function') throw new Error('Original Chat fetch is unavailable');
    const state = { original, wrapper: null, used: false, snapshot: null };
    const wrapper = function(input, init) {
      const url = typeof input === 'string' ? input : input?.url;
      if (url !== route) return original.call(window, input, init);
      if (state.used) throw new Error('QA interceptor refuses a second Chat send');
      if (expected.hiddenMarker && (expected.qaOutputMarkers.length !== 2
          || new Set(expected.qaOutputMarkers).size !== 2
          || expected.qaOutputMarkers.some(marker => !/^[A-Za-z0-9_-]{20,80}$/.test(marker)))) {
        throw new Error('Native QA requires two distinct bounded output markers before original fetch');
      }
      if (init?.method !== 'POST' || typeof init.body !== 'string') throw new Error('QA Chat send has an unknown request shape');
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
        if (!Number.isFinite(expected.browserTransportObservedAt)
            || Date.now() - expected.browserTransportObservedAt > 5000
            || expected.browserTransportObservedAt > Date.now()) {
          throw new Error('QA root SSE Browser transport is stale before original fetch');
        }
        const currentRoot = window.__egdesk?.browserAgentTools?.rootSseReady?.();
        if (currentRoot?.sourceReady !== true || currentRoot.eventSourceReadyState !== 1
            || currentRoot.browserTransportId !== expected.browserTransportId) {
          throw new Error('QA root SSE Browser transport changed before original fetch');
        }
        const source = selected[0];
        if (source.kind !== 'browser' || source.id !== expected.selectedSourceId ||
            source.sourceRef?.viewId !== expected.selectedCardId ||
            source.sourceRef?.profileId !== expected.selectedProfileId ||
            source.browserToolIdentity?.cardEpoch !== expected.selectedCardEpoch ||
            source.browserToolPermission !== 'interact' || source.selectedByUser !== true ||
            source.browserToolSelection?.threadId !== expected.clientThreadId ||
            typeof source.browserToolSelection?.token !== 'string' || !source.browserToolSelection.token ||
            body.browserTransportId !== expected.browserTransportId) {
          throw new Error('QA Chat Browser source token/transport is not bound to this Card and thread');
        }
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
      body.executionPolicy = { mode: expected.policyMode };
      if (expected.qaOutputMarkers.length) body.qaOutputMarkers = [...expected.qaOutputMarkers];
      const snapshot = { route, forwardedToOriginalFetch: true, requestId: body.requestId,
        clientThreadId: body.clientThreadId, conversationId: body.conversationId || null,
        cwd: body.cwd, profileEnabled: body.profileEnabled, personaFields: [],
        messageMatched: body.message === expected.message,
        hiddenMarkerAbsentFromModelAdmission: !expected.hiddenMarker
          || !modelAdmission.includes(expected.hiddenMarker),
        contextSnapshotIds: body.contextSnapshotIds || [], executionPolicy: body.executionPolicy,
        qaCommandNonce: body.qaCommandNonce || null,
        qaOutputMarkers: body.qaOutputMarkers || [],
        browserTransportId: body.browserTransportId || null,
        selectedSources: selected.map(source => ({ kind: source.kind,
          sourceId: source.id || null,
          cardId: source.sourceRef?.viewId || null, profileId: source.sourceRef?.profileId || null,
          permission: source.browserToolPermission || null, selectedByUser: source.selectedByUser === true,
          cardEpoch: source.browserToolIdentity?.cardEpoch || null,
          hasOneTimeToken: typeof source.browserToolSelection?.token === 'string'
            && !!source.browserToolSelection.token,
          tokenThreadId: source.browserToolSelection?.threadId || null })) };
      state.used = true;
      state.snapshot = snapshot;
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
  }, expected);
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

async function completedUiRun(harness, thread, prompt, deadlineMs, {
  cwd, sourceIds = [], qaOutputMarkers = [], policyMode = 'readOnlyQa',
  browserSelection = null, browserRootReady = null, conversationId = null,
} = {}) {
  assertTurnTimeBudget(deadlineMs);
  await ensureVisibleChatComposer(harness, deadlineMs);
  assert.equal((await chatIdentity(harness)).threadId, thread.id,
    'rendered Chat focus changed the selected QA thread before send');
  await installQaSendInterceptor(harness, { clientThreadId: thread.wireClientThreadId,
    localThreadId: thread.id,
    cwd, message: prompt, policyMode, qaOutputMarkers, sourceIds,
    hiddenMarker: qaOutputMarkers[0] || null,
    selectedCardId: browserSelection?.cardId || null,
    selectedSourceId: browserSelection?.sourceId || null,
    selectedProfileId: browserSelection?.profileId || null,
    selectedCardEpoch: browserSelection?.cardEpoch || null,
    browserTransportId: browserRootReady?.browserTransportId || null,
    browserTransportObservedAt: browserRootReady?.observedAt || null,
    conversationId });
  let observation;
  let active = null;
  let emitted = null;
  try {
    observation = await observeChatEvents(thread.wireClientThreadId);
    assertTurnTimeBudget(deadlineMs);
    await sendFromComposer(harness, prompt);
    emitted = await waitUntil(() => observedQaSend(harness), Boolean,
      { timeoutMs: 10000, intervalMs: 100 });
    if (browserSelection) {
      assertBrowserUiRequest(emitted, { cwd,
        clientThreadId: thread.wireClientThreadId, conversationId, selection: browserSelection });
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
    return { run: state.run, events: [...observation.events], active, emitted };
  } finally {
    try { await observation?.close(); }
    finally { await removeQaSendInterceptor(harness); }
  }
}

async function captureImmutableSource(harness, thread, sourceFile, deadlineMs) {
  assertBeforeDeadline(deadlineMs);
  return chrome(harness, async ({ threadId, file }) => {
    const bridge = window.__egdesk.codexBridge;
    const source = { id: `qa-source-${Math.random().toString(36).slice(2)}`, kind: 'file',
      label: 'Public QA source', sourceRef: { path: file } };
    const references = await bridge.captureInputs(threadId, [source]);
    const reference = references?.[0];
    if (!reference?.sourceId || reference.snapshotId !== reference.sourceId) throw new Error('production capture did not return bound source ID');
    // This is the existing immutable-reference attachment path. It does not
    // invoke a model, replace the transport, or mutate the source capture.
    bridge.attachBriefingComment(threadId, { text: '', contextSnapshotIds: [reference.sourceId] }, [reference]);
    const selected = window.__egdesk.state.codex.threads.find(item => item.id === threadId)?.briefingInputs || [];
    if (!selected.some(item => item.sourceId === reference.sourceId)) throw new Error('immutable reference was not attached to Chat draft');
    return { sourceId: reference.sourceId, snapshotId: reference.snapshotId, hash: reference.hash };
  }, { threadId: thread.id, file: sourceFile });
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
    return { targetCardId: target.id, controlCardId: control.id };
  }, { uri: fixtureUrl });
}

async function selectBrowserInteraction(harness, thread, cardId, deadlineMs) {
  assertBeforeDeadline(deadlineMs);
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
      sourceId: selected[0].id, cardEpoch: selected[0].browserToolIdentity?.cardEpoch || null,
      selectedByUser: true, permission: selected[0].browserToolPermission };
  }, { threadId: thread.id, cardId });
}

async function browserSnapshot(harness, targetCardId, controlCardId) {
  return chrome(harness, async ({ targetCardId, controlCardId }) => {
    const api = window.__egdesk;
    const target = await api.browserAgent.snapshot(targetCardId);
    const control = await api.browserAgent.snapshot(controlCardId);
    const input = target.interactiveElements?.find(item => item.label === 'QA note');
    const text = snapshot => Array.isArray(snapshot.text) ? snapshot.text.join('\n') : String(snapshot.text || '');
    const segments = snapshot => Array.isArray(snapshot.text) ? snapshot.text.map(String)
      : String(snapshot.text || '').split('\n');
    const targetInputFocused = !!input && target.focusedElement?.ref === input.ref;
    const focusedCardId = document.activeElement?.closest?.('.egd-browser-card')?.id || null;
    return { targetText: text(target), targetSegments: segments(target),
      inputValue: targetInputFocused ? target.focusedElement.value || '' : '',
      targetInputFocused, focusedCardId,
      controlText: text(control), controlInputValue: control.focusedElement?.value || '', controlCardId,
      cards: [...document.querySelectorAll('.egd-canvas-card')].map(node => node.id).sort(),
      camera: { pan: { ...api.state.panTarget }, zoom: api.state.zoomTarget,
        activeEntityId: api.state.activeEntityId || null } };
  }, { targetCardId, controlCardId });
}

async function main() {
  const deadlineMs = parseDeadlineUtc(required(option('--deadline-utc'), '--deadline-utc is required for real runs'));
  const cases = parseCases(required(option('--cases'), '--cases is required for real runs'));
  const browserFixture = cases.includes('browser')
    ? assertBrowserFixtureConfig(
      required(option('--browser-fixture-url'), '--browser-fixture-url is required for Browser QA'),
      required(option('--browser-fixture-marker'), '--browser-fixture-marker is required for Browser QA'))
    : null;
  const profile = required(option('--profile', process.env.EGDESK_FIREFOX_PROFILE), '--profile is required');
  assertBeforeDeadline(deadlineMs);
  assert.equal(process.env.EGDESK_MARIONETTE_PORT, '2828', 'Lane C attaches only Main-leased QA Firefox Marionette port 2828');
  assert.equal(process.env.EGDESK_QA_REAL_TURN, '1', 'explicit real-turn gate is required');
  assert.notEqual(process.env.EGDESK_QA_FIXTURE_TRANSPORT, '1', 'fixture transport is forbidden');
  await runUiFlow('native-tool-flow-real-chat', async ({ harness, check, result }) => {
    result.realExecutionVerified = false;
    result.requestedCases = cases;
    result.completedCases = [];
    result.providerTurns = [];
    assertBeforeDeadline(deadlineMs);
    const manifest = assertQaFixtureManifest(profile);
    check('dedicated real-turn fixture cwd exists', !!manifest.realTurnCwd);
    const bridge = await assertBridgePreflight();
    const nativeContractFingerprint = assertNativeQaCapabilityBeforeTurn(bridge.health);
    assertBeforeDeadline(deadlineMs);
    const qaCwd = createQaRunDirectory(manifest.realTurnCwd);
    const fixtures = makeFixtures(qaCwd);
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
    const sourceThread = await newQaThreadInVisibleChat(harness, 'QA immutable source read', deadlineMs);
    const reference = await captureImmutableSource(harness, sourceThread, fixtures.sourceFile, deadlineMs);
    const originalHash = sha256(fs.readFileSync(fixtures.sourceFile));
    check('production source capture binds original file bytes', reference.hash === originalHash);
    assertBeforeDeadline(deadlineMs);
    fs.writeFileSync(fixtures.sourceFile, `Public EG-Desk changed live QA source.\n${fixtures.changedNonce}\n`, { flag: 'w', mode: 0o600 });
    const currentHash = sha256(fs.readFileSync(fixtures.sourceFile));
    const reflectedSource = await reflectedOrdinaryRequest(harness, sourceThread, qaCwd, [reference.sourceId]);
    assertOrdinaryUiBaseline(reflectedSource, qaCwd);
    check('normal Chat baseline retains the selected immutable source',
      same(reflectedSource.contextSnapshotIds, [reference.sourceId]));
    const sourceBefore = fileInventory(qaCwd);
    const source = await completedUiRun(harness, sourceThread,
      'Use the attached immutable public QA source with egdesk_read_source. Report its original marker exactly. Do not read the current live file, write files, use network, or perform other work.',
      deadlineMs, { cwd: qaCwd, sourceIds: [reference.sourceId] });
    const sourceTurn = { case: 'source', runId: source.run.runId, status: 'completed', evidence: 'unverified' };
    result.providerTurns.push(sourceTurn);
    result.providerTurn = 'real-codex-completed-unverified';
    assertNativeAuthorityChain({ ...source, cwd: qaCwd });
    const sourceProof = assertSourceRead({ ...source, reference,
      originalNonce: fixtures.sourceNonce, changedNonce: fixtures.changedNonce, originalHash, currentHash,
      stored: await storedSource(harness, sourceThread, reference),
      beforeFiles: sourceBefore, afterFiles: fileInventory(qaCwd),
      changedFile: fixtures.sourceFile });
    result.source = { runId: source.run.runId, ...sourceProof };
    sourceTurn.evidence = 'verified';
    result.completedCases.push('source');
    }

    if (cases.includes('browser')) {
    assertBeforeDeadline(deadlineMs);
    await browserRootSseReceiptBeforeTurn(harness);
    const cards = await createBrowserCards(harness, browserFixture.url, deadlineMs);
    const before = await waitUntil(async () => {
      try { return await browserSnapshot(harness, cards.targetCardId, cards.controlCardId); }
      catch { return null; }
    }, value => value?.targetSegments?.includes(browserFixture.marker), { timeoutMs: 15000 });
    const browserThread = await newQaThreadInVisibleChat(harness, 'QA local Browser tools', deadlineMs);
    const selection = await selectBrowserInteraction(harness, browserThread, cards.targetCardId, deadlineMs);
    check('B UI explicitly selected only the local QA card for interaction', selection.cardId === cards.targetCardId
      && selection.selectedByUser === true && selection.permission === 'interact');
    const browserRootReady = await browserExecutionAuthorityBeforeTurn(harness, browserThread, selection,
      bridge.health, qaCwd);
    const browserBefore = fileInventory(qaCwd);
    const fillValue = 'harmless QA input';
    const browser = await completedUiRun(harness, browserThread,
      `Use EG-Desk Browser model tools on card ${cards.targetCardId} only. Observe it, click its "Reveal QA details" button, then deliberately try to act using the now-stale first observation and report the rejection. Re-observe and fill the harmless "QA note" input with ${JSON.stringify(fillValue)}. Never submit a form, navigate, use accounts or another card.`,
      deadlineMs, { cwd: qaCwd, sourceIds: null,
        policyMode: 'fixtureBrowserQa', browserSelection: selection, browserRootReady });
    const browserTurn = { case: 'browser-new-chat', runId: browser.run.runId, status: 'completed', evidence: 'unverified' };
    result.providerTurns.push(browserTurn);
    result.providerTurn = 'real-codex-completed-unverified';
    const after = await browserSnapshot(harness, cards.targetCardId, cards.controlCardId);
    const browserEvidence = await browserToolReceipts(browser.run);
    const browserProof = assertBrowserToolFlow({ ...browser, calls: browserEvidence.calls,
      selection,
      target: { cardId: cards.targetCardId, profileId: selection.profileId,
        fixtureMarker: browserFixture.marker, fillValue },
      control: { cardId: cards.controlCardId }, before, after });
    assertNoFixtureWrites(browserBefore, fileInventory(qaCwd));
    result.browser = { runId: browser.run.runId, ...browserProof };
    browserTurn.evidence = 'verified';
    result.completedCases.push('browser-new-chat');

    // The next target is attached only after the first turn completes, while
    // retaining the same native Chat conversation. This rejects accidental
    // new-thread or active-card fallback behavior.
    assertBeforeDeadline(deadlineMs);
    const laterCards = await createBrowserCards(harness, browserFixture.url, deadlineMs);
    const laterBefore = await waitUntil(async () => {
      try { return await browserSnapshot(harness, laterCards.targetCardId, cards.targetCardId); }
      catch { return null; }
    }, value => value?.targetSegments?.includes(browserFixture.marker), { timeoutMs: 15000 });
    const laterSelection = await selectBrowserInteraction(harness, browserThread, laterCards.targetCardId, deadlineMs);
    const laterSelectedAt = Date.now();
    const laterRootReady = await browserExecutionAuthorityBeforeTurn(harness, browserThread, laterSelection,
      bridge.health, qaCwd, browser.run.conversationId);
    const later = await completedUiRun(harness, browserThread,
      `In this same Chat, use EG-Desk Browser model tools only on newly added card ${laterCards.targetCardId}. Observe, click "Reveal QA details", verify an old observation is rejected, re-observe, and fill "QA note" with ${JSON.stringify(fillValue)}. Leave the first card untouched; do not navigate or submit anything.`,
      deadlineMs, { cwd: qaCwd, sourceIds: null, policyMode: 'fixtureBrowserQa',
        browserSelection: laterSelection, browserRootReady: laterRootReady,
        conversationId: browser.run.conversationId });
    const laterTurn = { case: 'browser-same-chat', runId: later.run.runId, status: 'completed', evidence: 'unverified' };
    result.providerTurns.push(laterTurn);
    result.providerTurn = 'real-codex-completed-unverified';
    const laterAfter = await browserSnapshot(harness, laterCards.targetCardId, cards.targetCardId);
    const laterEvidence = await browserToolReceipts(later.run);
    const laterProof = assertBrowserToolFlow({ ...later, calls: laterEvidence.calls,
      selection: laterSelection,
      target: { cardId: laterCards.targetCardId, profileId: laterSelection.profileId,
        fixtureMarker: browserFixture.marker, fillValue },
      control: { cardId: cards.targetCardId }, before: laterBefore, after: laterAfter });
    assertBrowserSameChatAddition({ firstRun: browser.run, laterRun: later.run,
      firstCompletedAt: browser.events.find(event => event.event === 'run.completed')?.ts,
      laterSelectedAt, firstCardId: cards.targetCardId, laterCardId: laterCards.targetCardId,
      laterSelection, before: { firstCardText: laterBefore.controlText, camera: laterBefore.camera },
      after: { firstCardText: laterAfter.controlText, camera: laterAfter.camera } });
    result.browserSameChat = { runId: later.run.runId, ...laterProof };
    laterTurn.evidence = 'verified';
    result.completedCases.push('browser-same-chat');

    assertBeforeDeadline(deadlineMs);
    const guards = await browserNegativeGuardReceipts(harness, later.run, laterSelection);
    assertBrowserNegativeGuards({ guards: guards.receipts, cardId: laterCards.targetCardId,
      profileId: laterSelection.profileId, stoppedAt: guards.stoppedAt,
      navigationFixtureUrl: guards.navigationFixtureUrl, fixtureMarker: browserFixture.marker });
    assertNoFixtureWrites(browserBefore, fileInventory(qaCwd));
    result.browserGuards = { cases: guards.receipts.map(item => item.case), stoppedAt: guards.stoppedAt };
    result.completedCases.push('browser-guards');
    result.completedCases.push('browser');
    }

    const coverage = scenarioCoverage(cases, result.completedCases);
    Object.assign(result, coverage);
    result.realExecutionVerified = coverage.fullScenarioVerified;
    result.providerTurn = coverage.fullScenarioVerified
      ? 'full-scenario-evidence-verified' : 'selected-cases-evidence-verified-partial';
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch (error) {
    process.exitCode = 1;
    process.stdout.write(`${JSON.stringify({ kind: 'native-tool-flow-real-chat', automatedAssertionsPassed: false,
      realExecutionVerified: false, providerTurn: 'not-run', error: error.message })}\n`);
  }
}
