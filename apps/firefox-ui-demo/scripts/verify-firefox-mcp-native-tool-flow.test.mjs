import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  parseDeadlineUtc, assertBeforeDeadline, assertTurnTimeBudget, parseCases, scenarioCoverage,
  chooseChatProxyTarget,
  harmlessPrintfCommand, nativeReadCommand, assertHiddenMarkerOutsideModelAdmission,
  assertRealTransport, assertNativeQaCapabilityBeforeTurn, assertEffectiveReadOnly,
  assertOrdinaryUiBaseline, assertUiQaRequest, assertBrowserUiRequest,
  assertFreshBrowserRootSse,
  assertNativeAuthorityChain, assertPendingReadOnlyNoSideEffect,
  assertNativeFileAndCommand, assertSourceRead, assertBrowserToolFlow,
  assertBrowserSameChatAddition, assertBrowserNegativeGuards,
  assertBrowserFixtureConfig, assertNoFixtureWrites,
} from './verify-firefox-mcp-native-tool-flow.mjs';

const cwd = '/private/var/folders/qa/egdesk-chat-test-unit/qa-fixtures/real-turn';
const nativeFile = `${cwd}/native-read.txt`;
const sourceFile = `${cwd}/source-read.txt`;
const clientThreadId = 'client-real-unit';
const policyReceipt = { mode: 'readOnlyQa', status: 'native-thread-verified',
  sandbox: 'readOnly', approvalPolicy: 'never', networkAccess: false,
  externalMcpCatalog: 'empty', inspectedMcpServers: 0 };
const nativeContractFingerprint = 'f'.repeat(64);
const event = (run, eventName, details = {}, itemId) => ({ type: 'chat.event', v: 2,
  provider: 'codex', clientThreadId, conversationId: run.conversationId, runId: run.runId,
  answerId: run.answerId, requestId: run.requestId, streamId: 'stream-unit',
  event: eventName, details,
  ...(itemId ? { itemId } : {}) });
const run = (runId = 'turn-native-1') => ({ conversationId: 'thread-native-1', runId,
  answerId: `thread-native-1/${runId}`, clientThreadId, requestId: 'request-real-unit', status: 'completed',
  cwdPublic: cwd, executionPolicy: policyReceipt,
  historyComplete: true, truncated: false, messages: [], activities: [] });
const life = value => [event(value, 'run.started'),
  ...(value.executionPolicy ? [event(value, 'run.executionPolicy', { executionPolicy: value.executionPolicy })] : []),
  event(value, 'run.completed', { status: 'completed' })]
  .map((item, index) => ({ ...item, seq: index + 1, ts: 100 + index * 100 }));
const inventory = Object.freeze({
  [nativeFile]: { sha256: 'a'.repeat(64), size: 40, mode: 0o600, mtimeNs: '1', ctimeNs: '1' },
  [sourceFile]: { sha256: 'b'.repeat(64), size: 40, mode: 0o600, mtimeNs: '1', ctimeNs: '1' },
});

test('real transport and effective native read-only policy are hard pre-turn gates', () => {
  const transport = { realTurn: '1', fixtureTransport: undefined,
    health: { ok: true, appServerReady: true, fixture: false },
    auth: { isLoggedIn: true, loginInProgress: false }, fixtureEndpointStatus: 404 };
  assert.equal(assertRealTransport(transport), true);
  assert.throws(() => assertRealTransport({ ...transport, health: { ...transport.health, fixture: true } }), /fixture/);
  assert.throws(() => assertRealTransport({ ...transport, fixtureEndpointStatus: 200 }), /fixture control/);
  assert.throws(() => assertRealTransport({ ...transport, auth: { isLoggedIn: false } }), /authentication/);
  assert.equal(assertEffectiveReadOnly(policyReceipt), true);
  assert.equal(assertNativeQaCapabilityBeforeTurn({ native: { schemaMatch: true, qaReadOnly: true,
    contractFingerprint: nativeContractFingerprint } }), nativeContractFingerprint);
  assert.throws(() => assertNativeQaCapabilityBeforeTurn({ native: { schemaMatch: true,
    qaReadOnly: false, contractFingerprint: nativeContractFingerprint } }), /not available/);
  for (const mutation of [{ status: 'requested' }, { sandbox: 'workspaceWrite' }, { networkAccess: true },
    { externalMcpCatalog: 'pending' }, { approvalPolicy: 'on-request' }]) {
    assert.throws(() => assertEffectiveReadOnly({ ...policyReceipt, ...mutation }));
  }
  assert.equal(assertOrdinaryUiBaseline({ cwd, profileEnabled: false, personaFields: [] }, cwd), true);
  const emitted = { route: 'http://127.0.0.1:39218/chat/send', forwardedToOriginalFetch: true,
    requestId: 'request-qa', clientThreadId, conversationId: null, messageMatched: true,
    cwd, profileEnabled: false, personaFields: [], contextSnapshotIds: [],
    executionPolicy: { mode: 'readOnlyQa' }, qaCommandNonce: null,
    qaOutputMarkers: [], hiddenMarkerAbsentFromModelAdmission: true };
  const expected = { cwd, clientThreadId, sourceIds: [] };
  assert.equal(assertUiQaRequest(emitted, expected), true);
  const markers = ['QA_NATIVE_0123456789abcdef01234567', 'QA_COMMAND_0123456789abcdef'];
  assert.equal(assertUiQaRequest({ ...emitted, qaOutputMarkers: markers },
    { ...expected, qaOutputMarkers: markers }), true);
  assert.throws(() => assertUiQaRequest({ ...emitted, forwardedToOriginalFetch: false }, expected), /original Chat fetch/);
  assert.throws(() => assertUiQaRequest({ ...emitted, executionPolicy: null }, expected), /readOnlyQa/);
  assert.throws(() => assertUiQaRequest({ ...emitted, qaCommandNonce: markers[1] }, expected), /legacy single-nonce/);
  assert.throws(() => assertUiQaRequest(emitted,
    { ...expected, qaOutputMarkers: markers }), /two distinct public QA output markers/);
  assert.throws(() => assertUiQaRequest({ ...emitted, qaOutputMarkers: markers,
    hiddenMarkerAbsentFromModelAdmission: false }, { ...expected, qaOutputMarkers: markers }), /model-facing admission/);
  const deadlineMs = parseDeadlineUtc('2026-10-09T01:00:00Z');
  assert.doesNotThrow(() => assertBeforeDeadline(deadlineMs, Date.parse('2026-10-09T00:59:59Z')));
  assert.throws(() => assertBeforeDeadline(deadlineMs, Date.parse('2026-10-09T01:00:00Z')), /deadline/);
  assert.throws(() => assertTurnTimeBudget(deadlineMs, Date.parse('2026-10-09T00:56:00Z')), /five minutes/);
  assert.equal(parseDeadlineUtc('2027-03-15T12:34:56.123Z'), Date.parse('2027-03-15T12:34:56.123Z'));
  for (const invalid of [undefined, '2026-10-09T01:00:00+00:00', '2026-10-09T01:00:00',
    '2026-02-30T01:00:00Z', '2026-10-09T01:00:00.1Z']) {
    assert.throws(() => parseDeadlineUtc(invalid));
  }
});

test('constructed harmless printf actually emits one newline in the local shell', () => {
  const token = 'QA_COMMAND_0123456789abcdef';
  const command = harmlessPrintfCommand(token);
  const child = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8', timeout: 1000 });
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  assert.equal(child.stdout, `${token}\n`);
  assert.equal(child.stdout.includes('\\n'), false);
  assert.equal(nativeReadCommand(nativeFile), `sed -n '1,2p' '${nativeFile}'`);
  const marker = 'QA_NATIVE_0123456789abcdef01234567';
  assert.equal(assertHiddenMarkerOutsideModelAdmission({ marker, message: 'read the fixture',
    title: 'QA native read', path: nativeFile, metadata: { sourceIds: [] } }), true);
  for (const location of [{ message: marker }, { title: marker }, { path: marker },
    { metadata: { sourceLabel: marker } }]) {
    assert.throws(() => assertHiddenMarkerOutsideModelAdmission({ marker,
      message: 'read fixture', title: 'QA native', path: nativeFile, metadata: {}, ...location }), /leaked/);
  }
});

test('explicit case selection verifies partial work without claiming full-scenario PASS', () => {
  assert.deepEqual(parseCases('native,source'), ['native', 'source']);
  assert.deepEqual(scenarioCoverage(['native', 'source'], ['native', 'source']), {
    selectedCasesVerified: true, fullScenarioVerified: false, coverage: 'partial' });
  assert.deepEqual(scenarioCoverage(['native', 'source', 'browser'], ['native', 'source', 'browser']), {
    selectedCasesVerified: true, fullScenarioVerified: true, coverage: 'full' });
  assert.deepEqual(scenarioCoverage(['native', 'source'], ['native']), {
    selectedCasesVerified: false, fullScenarioVerified: false, coverage: 'partial' });
  for (const invalid of [undefined, '', 'native,source,unknown', 'native,native', 'native, source']) {
    assert.throws(() => parseCases(invalid));
  }
});

test('compact Chat proxy is selected by observed active Card and never by an ambiguous fallback', () => {
  const proxies = [{ cardId: 'egd-chat-card-1', visible: true },
    { cardId: 'egd-chat-card-2', visible: true }];
  assert.equal(chooseChatProxyTarget(proxies, 'egd-chat-card-2'), 'egd-chat-card-2');
  assert.equal(chooseChatProxyTarget([{ cardId: 'egd-chat-card-2', visible: true }]), 'egd-chat-card-2');
  assert.equal(chooseChatProxyTarget([{ cardId: 'egd-chat-card-2', visible: false }]), null);
  assert.throws(() => chooseChatProxyTarget(proxies), /multiple visible/);
});

test('Browser preflight reflects exact selected Card, one-time token binding and bounded native policy', () => {
  const selection = { cardId: 'card-qa', profileId: 'profile-qa',
    sourceId: 'source-qa', cardEpoch: 'card-epoch-1' };
  const reflection = { cwd, profileEnabled: false, personaFields: [], conversationId: null,
    route: 'http://127.0.0.1:39218/chat/send', forwardedToOriginalFetch: true,
    requestId: 'request-browser', clientThreadId, messageMatched: true,
    executionPolicy: { mode: 'fixtureBrowserQa' }, browserTransportId: 'root-sse-qa-1',
    selectedSources: [{ kind: 'browser', sourceId: selection.sourceId,
      cardId: selection.cardId, profileId: selection.profileId,
      permission: 'interact', selectedByUser: true, cardEpoch: selection.cardEpoch,
      hasOneTimeToken: true, tokenThreadId: clientThreadId }] };
  const input = { cwd, clientThreadId, conversationId: null, selection };
  assert.equal(assertBrowserUiRequest(reflection, input), true);
  assert.throws(() => assertBrowserUiRequest({ ...reflection,
    executionPolicy: { mode: 'readOnlyQa' } }, input), /bounded native/);
  assert.throws(() => assertBrowserUiRequest({ ...reflection,
    selectedSources: [{ ...reflection.selectedSources[0], cardId: 'other' }] }, input), /another card/);
  assert.throws(() => assertBrowserUiRequest({ ...reflection,
    selectedSources: [{ ...reflection.selectedSources[0], cardEpoch: 'other' }] }, input), /Card generation/);
  assert.throws(() => assertBrowserUiRequest({ ...reflection,
    selectedSources: [{ ...reflection.selectedSources[0], tokenThreadId: 'other' }] }, input), /another Chat/);
  assert.throws(() => assertBrowserUiRequest({ ...reflection,
    selectedSources: [{ ...reflection.selectedSources[0], hasOneTimeToken: false }] }, input), /one-time/);
  assert.throws(() => assertBrowserUiRequest({ ...reflection,
    browserTransportId: null }, input), /transport binding/);
  assert.equal(assertBrowserUiRequest({ ...reflection, conversationId: 'conversation-1' },
    { ...input, conversationId: 'conversation-1' }), true);
  const ready = { sourceReady: true, eventSourceReadyState: 1,
    browserTransportId: 'root-sse-qa-1', observedAt: 1000 };
  assert.equal(assertFreshBrowserRootSse({ ready, emitted: reflection, now: 1001 }), true);
  assert.throws(() => assertFreshBrowserRootSse({ ready: { ...ready, sourceReady: false },
    emitted: reflection, now: 1001 }), /not received/);
  assert.throws(() => assertFreshBrowserRootSse({ ready, emitted: reflection,
    now: 7001 }), /stale/);
  assert.throws(() => assertFreshBrowserRootSse({ ready, emitted: { ...reflection,
    browserTransportId: 'other-root' }, now: 1001 }), /did not use/);
});

test('C correlates original SSE provider, active snapshot stream epoch and native policy before completion', () => {
  const value = run('turn-authority-1');
  const events = life(value);
  const active = { snapshot: { streamId: 'stream-unit', seq: 2 },
    run: { ...value, status: 'inProgress' } };
  const input = { run: value, events, active, cwd };
  assert.equal(assertNativeAuthorityChain(input), true);
  assert.throws(() => assertNativeAuthorityChain({ ...input,
    events: events.map(item => item.event === 'run.started' ? { ...item, provider: 'fixture' } : item) }), /non-Codex|original SSE/);
  assert.throws(() => assertNativeAuthorityChain({ ...input,
    active: { ...active, run: { ...active.run, runId: 'previous-run' } } }), /active-run ID/);
  assert.throws(() => assertNativeAuthorityChain({ ...input,
    active: { ...active, run: { ...active.run, requestId: 'other-send' } } }), /another UI send/);
  assert.throws(() => assertNativeAuthorityChain({ ...input,
    active: { ...active, snapshot: { ...active.snapshot, seq: 3 } } }), /before completion/);
  assert.throws(() => assertNativeAuthorityChain({ ...input,
    active: { ...active, snapshot: { ...active.snapshot, streamId: 'other-stream' } } }), /stream epochs/);
  assert.throws(() => assertNativeAuthorityChain({ ...input,
    active: { ...active, run: { ...active.run,
      executionPolicy: { ...policyReceipt, externalMcpCatalog: 'pending' } } } }), /active policy differs/);
});

test('C pending read-only refusal has no native turn, Browser dispatch or owned fixture write', () => {
  const input = { pending: { requestedPolicy: { mode: 'readOnlyQa' }, status: 'policy-pending',
    nativePolicyReceipt: null, activeRun: null, turnStartAttempted: false },
  beforeFiles: inventory, afterFiles: structuredClone(inventory), observedEvents: [],
  observedActivities: [], browserDispatchesBefore: 0, browserDispatchesAfter: 0 };
  assert.equal(assertPendingReadOnlyNoSideEffect(input), true);
  assert.throws(() => assertPendingReadOnlyNoSideEffect({ ...input,
    pending: { ...input.pending, turnStartAttempted: true } }), /turn\/start occurred/);
  assert.throws(() => assertPendingReadOnlyNoSideEffect({ ...input,
    observedEvents: [{ event: 'run.started' }] }), /activity began/);
  assert.throws(() => assertPendingReadOnlyNoSideEffect({ ...input,
    observedEvents: [{ event: 'message.delta' }] }), /activity began/);
  assert.throws(() => assertPendingReadOnlyNoSideEffect({ ...input,
    observedEvents: [{ event: 'browser-tool-request' }] }), /activity began/);
  assert.throws(() => assertPendingReadOnlyNoSideEffect({ ...input,
    browserDispatchesAfter: 1 }), /Browser actor/);
  assert.throws(() => assertPendingReadOnlyNoSideEffect({ ...input,
    afterFiles: { ...inventory, [nativeFile]: { ...inventory[nativeFile], ctimeNs: '2' } } }), /provider changed/);
});

test('two distinct native items need independent A aggregate-output marker receipts', () => {
  const value = run();
  const fileNonce = 'QA_NATIVE_0123456789abcdef01234567';
  const commandTag = 'QA_COMMAND_tag_0123456789';
  const digest = text => createHash('sha256').update(text).digest('hex');
  value.messages = [{ role: 'assistant', text: `${fileNonce} and ${commandTag}` }];
  value.activities = [
    { id: 'read-1', kind: 'commandExecution', status: 'completed',
      detail: { command: nativeReadCommand(nativeFile), cwd, exitCode: 0 } },
    { id: 'cmd-2', kind: 'commandExecution', status: 'completed',
      detail: { command: harmlessPrintfCommand(commandTag), cwd, exitCode: 0 } },
  ];
  const baseReceipt = { nativeItemType: 'commandExecution',
    origin: 'codex-app-server.item/completed', originalProviderId: 'codex-native',
    outputStream: 'aggregated-stdout-stderr', nativeItemStatus: 'completed',
    exitCode: 0, status: 'marker-witness', receiptScope: 'single-native-command-item',
    commandHashBasis: 'sanitized-native-item-command', bridgeEpoch: 7,
    contractFingerprint: nativeContractFingerprint };
  const readReceipt = { ...baseReceipt, nativeItemId: 'read-1', markerLines: [fileNonce],
    commandSha256: digest(nativeReadCommand(nativeFile)) };
  const commandReceipt = { ...baseReceipt, nativeItemId: 'cmd-2', markerLines: [commandTag],
    commandSha256: digest(harmlessPrintfCommand(commandTag)) };
  value.qaCommandReceipts = [readReceipt, commandReceipt];
  const events = life(value);
  events.splice(2, 0,
    { ...event(value, 'qa.command.receipt', readReceipt, 'read-1'), seq: 3, ts: 230 },
    { ...event(value, 'qa.command.receipt', commandReceipt, 'cmd-2'), seq: 4, ts: 240 });
  events[4] = { ...events[4], seq: 5 };
  const input = { run: value, events, nativeFile,
    readCommand: nativeReadCommand(nativeFile),
    nonce: fileNonce, commandTag, nativeContractFingerprint,
    beforeFiles: inventory, afterFiles: structuredClone(inventory) };
  assert.deepEqual(assertNativeFileAndCommand(input), { readItemId: 'read-1', commandItemId: 'cmd-2',
    commandOutput: { kind: 'aggregate-output-marker-lines', verifiedMarkers: 2 } });
  assert.throws(() => assertNativeFileAndCommand({ ...input, run: { ...value, qaCommandReceipts: [] } }), /receipts are unavailable/);
  assert.throws(() => assertNativeFileAndCommand({ ...input, run: { ...value,
    qaCommandReceipts: [{ ...readReceipt, originalProviderId: 'fixture' }, commandReceipt] } }), /file-read item/);
  assert.throws(() => assertNativeFileAndCommand({ ...input, run: { ...value,
    qaCommandReceipts: [readReceipt, { ...commandReceipt, nativeItemId: 'spoof' }] } }), /harmless command/);
  assert.throws(() => assertNativeFileAndCommand({ ...input, run: { ...value,
    qaCommandReceipts: [{ ...readReceipt, markerLines: [] }, commandReceipt] } }), /file-read item/);
  assert.throws(() => assertNativeFileAndCommand({ ...input, run: { ...value,
    qaCommandReceipts: [{ ...readReceipt, markerLines: [commandTag] }, commandReceipt] } }), /file-read item/);
  assert.throws(() => assertNativeFileAndCommand({ ...input, run: { ...value,
    qaCommandReceipts: [{ ...readReceipt, status: 'no-marker-witness' }, commandReceipt] } }), /file-read item/);
  assert.throws(() => assertNativeFileAndCommand({ ...input, run: { ...value,
    qaCommandReceipts: [{ ...readReceipt, receiptScope: 'combined-turn' }, commandReceipt] } }), /file-read item/);
  assert.throws(() => assertNativeFileAndCommand({ ...input, run: { ...value,
    qaCommandReceipts: [{ ...readReceipt, markerLines: [fileNonce, commandTag] }, commandReceipt] } }), /file-read item/);
  assert.throws(() => assertNativeFileAndCommand({ ...input,
    events: events.filter(item => item.itemId !== 'read-1') }), /SSE item/);
  assert.throws(() => assertNativeFileAndCommand({ ...input,
    events: events.map(item => item.event === 'qa.command.receipt'
      ? { ...item, requestId: 'other-request' } : item) }), /SSE item/);
  assert.throws(() => assertNativeFileAndCommand({ ...input,
    nativeContractFingerprint: 'e'.repeat(64) }), /file-read item/);
  assert.throws(() => assertNativeFileAndCommand({ ...input, run: { ...value,
    qaCommandReceipts: [readReceipt, { ...commandReceipt, commandSha256: 'a'.repeat(64) }] } }), /harmless command/);
  assert.throws(() => assertNativeFileAndCommand({ ...input, run: { ...value,
    messages: [{ role: 'assistant', text: commandTag }] } }), /unprompted/);
  assert.throws(() => assertNativeFileAndCommand({ ...input, afterFiles: { ...inventory,
    [nativeFile]: { ...inventory[nativeFile], mtimeNs: '2' } } }), /provider changed/);
  assert.throws(() => assertNativeFileAndCommand({ ...input, run: { ...value, activities: [...value.activities,
    { id: 'write', kind: 'fileChange' }] } }), /file changes/);
  assert.throws(() => assertNativeFileAndCommand({ ...input, run: { ...value, activities: [...value.activities,
    { id: 'extra', kind: 'commandExecution', status: 'completed', detail: { exitCode: 0 } }] } }), /two scoped commands/);
  assert.throws(() => assertNativeFileAndCommand({ ...input, run: { ...value,
    executionPolicy: { ...policyReceipt, externalMcpCatalog: 'pending' } } }), /MCP catalog/);
});

test('source proof needs named native tool call, original snapshot binding and delivered packet', () => {
  const value = run('turn-source-1');
  value.messages = [{ role: 'assistant', text: 'Original QA_SOURCE_earlier' }];
  value.activities = [{ id: 'call-source-1', kind: 'dynamicToolCall', status: 'completed',
    detail: { tool: 'egdesk_read_source' } }];
  value.context = { captures: [{ sourceId: 'source-1', hash: 'original-hash' }],
    packets: [{ sourceId: 'source-1', packetId: 'packet-1', receiptId: 'delivery-1',
      mode: 'direct', coverage: { sourceTruncated: false } }] };
  const reference = { sourceId: 'source-1', snapshotId: 'source-1', hash: 'original-hash' };
  const stored = { capture: { sourceId: 'source-1', hash: 'original-hash' },
    source: { text: 'QA_SOURCE_earlier' },
    delivered: { packetId: 'packet-1', deliveryStatus: 'sent-to-app-server' } };
  const events = [...life(value), event(value, 'context.read.completed', {
    sourceId: 'source-1', packetId: 'packet-1', receiptId: 'delivery-1',
    mode: 'direct', deliveryStatus: 'sent-to-app-server' }, 'call-source-1')];
  const input = { run: value, events, reference, originalNonce: 'QA_SOURCE_earlier',
    changedNonce: 'QA_SOURCE_later', originalHash: 'original-hash', currentHash: 'changed-hash',
    stored, beforeFiles: inventory, afterFiles: structuredClone(inventory),
    changedFile: sourceFile };
  assert.deepEqual(assertSourceRead(input), { sourceId: 'source-1', nativeCallId: 'call-source-1',
    packetId: 'packet-1', readMode: 'direct' });
  assert.throws(() => assertSourceRead({ ...input, events: life(value) }), /named native/);
  assert.throws(() => assertSourceRead({ ...input, events: events.map(item => item.event === 'context.read.completed'
    ? { ...item, itemId: 'other' } : item) }), /named native/);
  assert.throws(() => assertSourceRead({ ...input, run: { ...value, activities: [] } }), /named native/);
  assert.throws(() => assertSourceRead({ ...input, stored: { ...stored, source: { text: 'QA_SOURCE_later' } } }), /original nonce/);
  assert.throws(() => assertSourceRead({ ...input, run: { ...value, context: { ...value.context, captures: [] } } }), /binding/);
  assert.throws(() => assertSourceRead({ ...input, run: { ...value,
    activities: [...value.activities, { id: 'native-read', kind: 'commandExecution' }] } }), /not distinct/);
  assert.throws(() => assertSourceRead({ ...input, run: { ...value, context: { ...value.context,
    packets: [{ ...value.context.packets[0], coverage: { sourceTruncated: true } }] } } }), /SmartRead/);
});

test('Browser proof is tied to real model tool activities, card/profile/revisions, stale rejection and independent DOM', () => {
  const value = run('turn-browser-1');
  const interactionPolicy = { mode: 'fixtureBrowserQa', status: 'native-thread-verified',
    sandbox: 'readOnly', approvalPolicy: 'never', networkAccess: false,
    externalMcpCatalog: 'empty', browserEffects: 'attested-local-fixture-only' };
  value.executionPolicy = interactionPolicy;
  const active = { snapshot: { streamId: 'stream-unit', seq: 2 },
    run: { ...value, status: 'inProgress' } };
  const target = { cardId: 'card-target', profileId: 'qa-browser-profile',
    fixtureMarker: 'QA_DOM_0123456789abcdef',
    fillValue: 'harmless QA input' };
  const toolNames = { observe: 'egdesk_browser_observe', click: 'egdesk_browser_click',
    fill: 'egdesk_browser_fill' };
  const call = (itemId, kind, extra = {}) => ({ origin: 'native-dynamic-tool',
    conversationId: value.conversationId, runId: value.runId, itemId,
    cardId: target.cardId, profileId: target.profileId, bridgeEpoch: 7,
    targetCardEpoch: 'card-epoch-1', sourceId: 'source-qa-1', documentRevision: 1,
    toolName: toolNames[kind], kind, status: 'completed', ...extra });
  const calls = [
    call('observe-1', 'observe', { observationId: 'obs-1' }),
    call('click-1', 'click', { observationId: 'obs-1', resultRevision: 2,
      changedNodes: [{ nodeId: 'qa-changed', text: 'Newly revealed node' }] }),
    call('stale-1', 'click', { observationId: 'obs-1', status: 'rejected', code: 'BROWSER_OBSERVATION_STALE' }),
    call('observe-2', 'observe', { observationId: 'obs-2', documentRevision: 2 }),
    call('fill-1', 'fill', { observationId: 'obs-2', documentRevision: 2,
      resultValue: target.fillValue }),
  ];
  value.activities = calls.map(item => ({ id: item.itemId, kind: 'dynamicToolCall', status: 'completed',
    detail: { tool: item.toolName } }));
  value.browserBinding = { cards: [{ cardId: target.cardId, permission: 'interact',
    cardEpoch: 'card-epoch-1', sourceId: 'source-qa-1' }] };
  const before = { targetText: 'Waiting for QA action',
    targetSegments: ['Waiting for QA action', target.fixtureMarker], inputValue: '',
    targetInputFocused: false, focusedCardId: null,
    controlCardId: 'card-control', controlText: '', controlInputValue: '',
    cards: ['card-control', 'card-target'], camera: { pan: { x: 0, y: 0 }, zoom: 1 } };
  const after = { ...before, targetText: 'Changed by QA click\nNewly revealed node',
    targetSegments: ['Changed by QA click', 'Newly revealed node', target.fixtureMarker],
    inputValue: target.fillValue, targetInputFocused: true, focusedCardId: target.cardId };
  const selection = { selectedByUser: true, permission: 'interact',
    cardId: target.cardId, profileId: target.profileId,
    cardEpoch: 'card-epoch-1', sourceId: 'source-qa-1' };
  const events = life(value);
  events[2] = { ...events[2], seq: 9 };
  events.splice(2, 0, { ...event(value, 'browser.bound', value.browserBinding), seq: 3 },
    ...calls.map((item, index) => ({ ...event(value,
      item.status === 'rejected' ? 'browser.tool.failed' : 'browser.tool.completed',
      { originalProviderId: 'egdesk-browser', cardId: target.cardId,
        sourceId: selection.sourceId, targetCardEpoch: selection.cardEpoch,
        bridgeEpoch: item.bridgeEpoch }, item.itemId), seq: 4 + index })));
  const input = { run: value, events, active, calls, selection, target,
    control: { cardId: 'card-control' }, before, after };
  assert.equal(assertBrowserToolFlow(input).staleItemId, 'stale-1');
  assert.throws(() => assertBrowserToolFlow({ ...input, calls: calls.map(item => ({ ...item, origin: 'fixture' })) }), /native model/);
  assert.throws(() => assertBrowserToolFlow({ ...input, calls: calls.map(item => ({ ...item, toolName: 'other_tool' })) }), /B native tools/);
  assert.throws(() => assertBrowserToolFlow({ ...input, calls: calls.map(item => ({ ...item, cardId: 'card-control' })) }), /wrong card/);
  assert.throws(() => assertBrowserToolFlow({ ...input, selection: { ...selection, permission: 'observe' } }), /not permitted/);
  assert.throws(() => assertBrowserToolFlow({ ...input, run: { ...value, executionPolicy: policyReceipt } }), /active policy differs|distinct bounded policy/);
  assert.throws(() => assertBrowserToolFlow({ ...input, run: { ...value,
    executionPolicy: { ...interactionPolicy, browserEffects: null } } }), /active policy differs|effect boundary/);
  assert.throws(() => assertBrowserToolFlow({ ...input, calls: calls.map(item => ({ ...item, bridgeEpoch: 8 })) }), /native tool receipt|bridge epochs/);
  assert.throws(() => assertBrowserToolFlow({ ...input, run: { ...value,
    browserBinding: { cards: [{ ...value.browserBinding.cards[0], cardEpoch: 'other' }] } } }), /Card epochs/);
  assert.throws(() => assertBrowserToolFlow({ ...input, calls: calls.filter(item => item.itemId !== 'stale-1') }), /receipts|sequence/);
  assert.throws(() => assertBrowserToolFlow({ ...input, calls: calls.map(item => item.itemId === 'click-1'
    ? { ...item, changedNodes: [] } : item) }), /changed-node/);
  assert.throws(() => assertBrowserToolFlow({ ...input, after: { ...after, targetText: before.targetText } }), /changed node/);
  assert.throws(() => assertBrowserToolFlow({ ...input, after: { ...after, camera: { pan: { x: 1, y: 0 }, zoom: 1 } } }), /pan\/zoom/);
  assert.throws(() => assertBrowserToolFlow({ ...input, after: { ...after, controlText: 'wrong card changed' } }), /wrong-card/);
  assert.throws(() => assertBrowserToolFlow({ ...input, after: { ...after, targetInputFocused: false } }), /focus/);
});

test('later target is a distinct card selected for a new turn in the same Chat', () => {
  const firstRun = run('turn-browser-first');
  const laterRun = { ...run('turn-browser-later'), conversationId: firstRun.conversationId };
  const data = { firstRun, laterRun, firstCompletedAt: 100, laterSelectedAt: 101,
    firstCardId: 'card-one', laterCardId: 'card-two',
    laterSelection: { cardId: 'card-two', permission: 'interact' },
    before: { firstCardText: 'first card unchanged', camera: { pan: { x: 0, y: 0 }, zoom: 1 } },
    after: { firstCardText: 'first card unchanged', camera: { pan: { x: 0, y: 0 }, zoom: 1 } } };
  assert.equal(assertBrowserSameChatAddition(data), true);
  assert.throws(() => assertBrowserSameChatAddition({ ...data,
    laterRun: { ...laterRun, conversationId: 'other' } }), /same native Chat/);
  assert.throws(() => assertBrowserSameChatAddition({ ...data, laterSelectedAt: 99 }), /after the first turn/);
  assert.throws(() => assertBrowserSameChatAddition({ ...data,
    after: { ...data.after, firstCardText: 'wrong card changed' } }), /first card changed/);
});

test('C rejects Browser cancel-before-act, forbidden schemes and permission escalation without fixture effects', () => {
  const stoppedAt = 100;
  const names = ['dom-stale', 'viewport-stale', 'cancel-before-act',
    'scheme-denial-data', 'scheme-denial-file', 'scheme-denial-javascript',
    'permission-escalation', 'expired-after-stop', 'cancelled-after-stop'];
  const deniedUrl = { 'scheme-denial-data': 'data:text/html,owned',
    'scheme-denial-file': 'file:///private/var/owned.html',
    'scheme-denial-javascript': 'javascript:alert(1)' };
  const guards = names.map((name, index) => ({
    case: name, origin: name.startsWith('scheme-denial-') || name === 'permission-escalation'
      ? 'native-dynamic-tool-rejection' : 'live-browser-tool-transport',
    nativeItemId: `item-${index}`, cardId: 'card-target', profileId: 'qa-profile',
    requestId: `request-${index}`, runId: 'run-owned',
    status: 'rejected', actorDispatchesBefore: index, actorDispatchesAfter: index,
    beforeAttempt: { url: 'data:text/html,owned', text: 'owned fixture', value: '' },
    afterAttempt: { url: 'data:text/html,owned', text: 'owned fixture', value: '' },
    attemptedUrl: deniedUrl[name] || null,
    attemptedTool: name.startsWith('scheme-denial-') ? 'egdesk_browser_navigate' : 'egdesk_browser_click',
    errorCode: name.startsWith('scheme-denial-') ? 'INVALID_BROWSER_TOOL'
      : name === 'permission-escalation' ? 'BROWSER_INTERACTION_NOT_GRANTED' : 'BROWSER_REJECTED',
    selectedPermission: 'observe', permissionAfter: 'observe',
    attemptedAt: 101, cancelReceipt: { status: 'cancelled', runId: 'run-owned',
      cardId: 'card-target', at: 100 },
  }));
  const data = { guards, cardId: 'card-target', profileId: 'qa-profile', stoppedAt,
    navigationFixtureUrl: 'http://127.0.0.1:39218/egdesk-qa/QA_URL_0123456789abcdef',
    fixtureMarker: 'QA_DOM_0123456789abcdef' };
  assert.equal(assertBrowserNegativeGuards(data), true);
  assert.equal(assertBrowserFixtureConfig(data.navigationFixtureUrl, data.fixtureMarker).marker,
    data.fixtureMarker);
  for (const url of ['data:text/html,owned', 'file:///private/var/owned.html',
    'javascript:alert(1)', 'https://example.com/', 'http://127.0.0.1:40000/']) {
    assert.throws(() => assertBrowserFixtureConfig(url, data.fixtureMarker));
  }
  assert.throws(() => assertBrowserFixtureConfig(data.navigationFixtureUrl,
    'QA_URL_0123456789abcdef'), /must differ/);
  assert.throws(() => assertBrowserNegativeGuards({ ...data,
    guards: guards.map(item => item.case === 'viewport-stale' ? { ...item, actorDispatchesAfter: 10 } : item) }), /reached the actor/);
  assert.throws(() => assertBrowserNegativeGuards({ ...data,
    guards: guards.map(item => item.case === 'cancelled-after-stop' ? { ...item, attemptedAt: 99 } : item) }), /preceding owned-run/);
  assert.throws(() => assertBrowserNegativeGuards({ ...data,
    guards: guards.map(item => item.case === 'dom-stale' ? { ...item, origin: 'synthetic' } : item) }), /wrong rejection boundary/);
  assert.throws(() => assertBrowserNegativeGuards({ ...data,
    guards: guards.map(item => item.case === 'dom-stale' ? { ...item, beforeAttempt: null } : item) }), /before\/after/);
  assert.throws(() => assertBrowserNegativeGuards({ ...data,
    guards: guards.map(item => item.case === 'cancel-before-act' ? { ...item,
      cancelReceipt: { ...item.cancelReceipt, at: 102 } } : item) }), /earlier owned cancellation/);
  assert.throws(() => assertBrowserNegativeGuards({ ...data,
    guards: guards.map(item => item.case === 'scheme-denial-file' ? { ...item,
      attemptedUrl: 'https://example.com/' } : item) }), /denied scheme/);
  assert.throws(() => assertBrowserNegativeGuards({ ...data,
    guards: guards.map(item => item.case === 'permission-escalation' ? { ...item,
      permissionAfter: 'interact' } : item) }), /elevated Browser permission/);
  assert.throws(() => assertBrowserNegativeGuards({ ...data,
    guards: guards.map(item => item.case === 'permission-escalation' ? { ...item,
      errorCode: 'BROWSER_ACTION_UNVERIFIED' } : item) }), /permission boundary/);
});

test('independent fixture recheck catches added, removed and same-content rewritten files', () => {
  assert.equal(assertNoFixtureWrites(inventory, structuredClone(inventory)), true);
  assert.throws(() => assertNoFixtureWrites(inventory, { ...inventory, [`${cwd}/extra.txt`]: {} }), /inventory changed/);
  assert.throws(() => assertNoFixtureWrites(inventory, { [nativeFile]: inventory[nativeFile] }), /inventory changed/);
  assert.throws(() => assertNoFixtureWrites(inventory, { ...inventory,
    [sourceFile]: { ...inventory[sourceFile], ctimeNs: '2' } }), /provider changed/);
});
