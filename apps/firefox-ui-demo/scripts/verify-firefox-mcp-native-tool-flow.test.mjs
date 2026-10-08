import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  parseDeadlineUtc, assertBeforeDeadline, assertTurnTimeBudget, parseCases, scenarioCoverage,
  parseResumeEmptyThreadId, assertResumeEmptyThreadState,
  parseResumeSourceOptions, assertPreparedSourceResumeEvidence,
  chooseChatProxyTarget,
  harmlessPrintfCommand, nativeReadCommand, nativeZshWrappedCommand,
  assertHiddenMarkerOutsideModelAdmission,
  assertRealTransport, assertMemoryIsolationBeforeTurn,
  assertNativeQaCapabilityBeforeTurn, assertEffectiveReadOnly,
  assertOrdinaryUiBaseline, assertUiQaRequest, assertBrowserUiRequest,
  assertFreshBrowserRootSse,
  assertNativeAuthorityChain, assertPendingReadOnlyNoSideEffect,
  assertNativeFileAndCommand, assertSourceRead, assertBrowserToolFlow,
  browserToolReceipts, assertBrowserPositiveFlow,
  assertPublicBrowserSseBindings,
  assertBrowserSameChatAddition, assertBrowserNegativeGuards,
  assertBrowserFixtureConfig, browserFixtureHtml, createBrowserFixtureHandler,
  assertBrowserFixtureServerReady,
  assertNoFixtureWrites,
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
    health: { ok: true, appServerReady: true, fixture: false,
      memoryIsolation: { feature: 'memories', status: 'verified-disabled' } },
    auth: { isLoggedIn: true, loginInProgress: false }, fixtureEndpointStatus: 404 };
  assert.equal(assertRealTransport(transport), true);
  assert.equal(assertMemoryIsolationBeforeTurn(transport.health), true);
  for (const receipt of [undefined,
    { feature: 'memories', status: 'not-requested' },
    { feature: 'memories', status: 'blocked' },
    { feature: 'other', status: 'verified-disabled' }]) {
    assert.throws(() => assertRealTransport({ ...transport,
      health: { ...transport.health, memoryIsolation: receipt } }), /memories.*isolation/);
  }
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
  assert.equal(nativeZshWrappedCommand(nativeReadCommand(nativeFile)),
    `/bin/zsh -lc "sed -n '1,2p' '${nativeFile}'"`);
  assert.equal(nativeZshWrappedCommand(command),
    String.raw`/bin/zsh -lc "printf '%s\\n' 'QA_COMMAND_0123456789abcdef'"`);
  const wrapped = spawnSync('/bin/sh', ['-c', nativeZshWrappedCommand(command)],
    { encoding: 'utf8', timeout: 1000 });
  assert.equal(wrapped.status, 0);
  assert.equal(wrapped.stderr, '');
  assert.equal(wrapped.stdout, `${token}\n`);
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
    selectedCasesVerified: true, fullScenarioVerified: false, coverage: 'partial' });
  assert.deepEqual(scenarioCoverage(['native', 'source', 'browser', 'browser-negative'],
    ['native', 'source', 'browser', 'browser-negative']), {
    selectedCasesVerified: true, fullScenarioVerified: true, coverage: 'full' });
  assert.deepEqual(scenarioCoverage(['native', 'source'], ['native']), {
    selectedCasesVerified: false, fullScenarioVerified: false, coverage: 'partial' });
  for (const invalid of [undefined, '', 'native,source,unknown', 'native,native', 'native, source']) {
    assert.throws(() => parseCases(invalid));
  }
});

test('source-only resume accepts one already active empty ordinary room and rejects uncertain reuse', () => {
  const id = 'thread-dm-mqpbdbw';
  assert.equal(parseResumeEmptyThreadId(id, ['source']), id);
  assert.equal(parseResumeEmptyThreadId(null, ['source']), null);
  assert.throws(() => parseResumeEmptyThreadId(id, ['native', 'source']), /only with --cases source/);
  assert.throws(() => parseResumeEmptyThreadId('thread-dm-other', ['source']), /generated DM thread/);
  const observed = { activeThreadId: id,
    thread: { id, title: 'Codex 3', conversationId: null, localConversationId: null,
      profileEnabled: false, bindingState: 'fresh', bindingAccountKey: null,
      nativeBindingHeld: false, messagesCount: 0, inputSourcesCount: 0,
      briefingInputsCount: 0, preparingInput: false, resuming: false, sendError: null },
    nativeRunCount: 0, visibleInputCount: 1, composerVisible: true,
    inputThreadId: id, inputValue: '', draftText: '', wireClientThreadId: id };
  assert.equal(assertResumeEmptyThreadState(observed, id), true);
  assert.throws(() => assertResumeEmptyThreadState({ ...observed,
    thread: { ...observed.thread, messagesCount: 1 } }, id), /already has messages/);
  assert.throws(() => assertResumeEmptyThreadState({ ...observed,
    thread: { ...observed.thread, nativeBindingHeld: true } }, id), /retains a native binding/);
  assert.throws(() => assertResumeEmptyThreadState({ ...observed,
    briefingInputsCount: 1, thread: { ...observed.thread, briefingInputsCount: 1 } }, id), /briefing inputs/);
  assert.throws(() => assertResumeEmptyThreadState({ ...observed,
    inputThreadId: 'other-room' }, id), /composer belongs/);
  assert.throws(() => assertResumeEmptyThreadState({ ...observed,
    draftText: 'unsent' }, id), /saved draft/);
});

test('prepared source resume preserves the exact unsent draft, old snapshot and changed live file', () => {
  const threadId = 'thread-dm-mqpbdbw';
  const root = `${cwd}/lane-c-LRmCLl`;
  const sourceId = '6bf7d32f-cbc0-455c-9918-b9dcf1f146eb';
  const sourceFile = `${root}/source-read.txt`;
  const originalNonce = `QA_SOURCE_ORIGINAL_${'a'.repeat(24)}`;
  const changedNonce = `QA_SOURCE_LIVE_${'b'.repeat(24)}`;
  const originalText = `Public EG-Desk source QA fixture.\n${originalNonce}\n`;
  const liveText = `Public EG-Desk changed live QA source.\n${changedNonce}\n`;
  const originalHash = createHash('sha256').update(originalText).digest('hex');
  const prompt = 'Use the attached immutable public QA source with egdesk_read_source. Report its original marker exactly. Do not read the current live file, write files, use network, or perform other work.';
  const expected = parseResumeSourceOptions({ threadId, root, sourceId, originalHash }, ['source']);
  assert.deepEqual(expected, { threadId, root, sourceId, originalHash });
  assert.equal(parseResumeSourceOptions({ threadId: null, root: null, sourceId: null,
    originalHash: null }, ['source']), null);
  assert.throws(() => parseResumeSourceOptions({ threadId, root, sourceId, originalHash },
    ['native', 'source']), /only with --cases source/);
  assert.throws(() => parseResumeSourceOptions({ threadId, root, sourceId, originalHash },
    ['source'], threadId), /cannot also resume/);
  assert.throws(() => parseResumeSourceOptions({ threadId, root, sourceId,
    originalHash: 'a'.repeat(16) }, ['source']), /prior capture receipt hash/);
  const reference = { sourceId, snapshotId: sourceId, hash: originalHash,
    sourceRef: { path: sourceFile }, localSource: { sourceRef: { path: sourceFile } } };
  const observed = { activeThreadId: threadId, wireClientThreadId: clientThreadId,
    thread: { id: threadId, title: 'QA immutable source read', cwd: root,
      conversationId: null, localConversationId: null, profileEnabled: false,
      bindingState: 'fresh', bindingAccountKey: null, nativeBindingHeld: false,
      messagesCount: 0, inputSourcesCount: 0, briefingInputsCount: 1,
      preparingInput: false, resuming: false, sendError: null },
    reference, nativeRunCount: 0, composerVisible: true, visibleInputCount: 1,
    inputThreadId: threadId, inputValue: prompt, draftText: prompt,
    sendButtonVisible: true, sendButtonEnabled: true, sendButtonUnobscured: true };
  const stored = { capture: { sourceId, clientThreadId, hash: originalHash,
    sourceRef: { path: sourceFile } }, source: { text: originalText },
    delivered: null, bindings: [] };
  const input = { observed, expected, stored, originalHash, liveText, sourceFile, prompt };
  assert.deepEqual(assertPreparedSourceResumeEvidence(input), { reference, originalNonce,
    changedNonce, originalHash, currentHash: createHash('sha256').update(liveText).digest('hex') });
  assert.throws(() => assertPreparedSourceResumeEvidence({ ...input,
    observed: { ...observed, thread: { ...observed.thread, messagesCount: 1 } } }), /has messages/);
  assert.throws(() => assertPreparedSourceResumeEvidence({ ...input,
    observed: { ...observed, sendButtonUnobscured: false } }), /obscured/);
  assert.throws(() => assertPreparedSourceResumeEvidence({ ...input,
    observed: { ...observed, reference: { ...reference, sourceId: 'other' } } }), /source ID changed/);
  assert.throws(() => assertPreparedSourceResumeEvidence({ ...input,
    stored: { ...stored, delivered: { packetId: 'prior' } } }), /earlier delivered/);
  assert.throws(() => assertPreparedSourceResumeEvidence({ ...input,
    stored: { ...stored, bindings: [{ runId: 'prior' }] } }), /already bound/);
  assert.throws(() => assertPreparedSourceResumeEvidence({ ...input,
    liveText: originalText }), /expected changed text/);
  const leakedPrompt = `${prompt} ${originalNonce}`;
  assert.throws(() => assertPreparedSourceResumeEvidence({ ...input, prompt: leakedPrompt,
    observed: { ...observed, inputValue: leakedPrompt, draftText: leakedPrompt } }),
  /marker leaked/);
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
  const fixtureUrl = 'http://127.0.0.1:39220/egdesk-qa/QA_URL_0123456789abcdef';
  const selection = { cardId: 'card-qa', profileId: 'profile-qa',
    sourceId: 'source-qa', cardEpoch: 'card-epoch-1', uri: fixtureUrl, accountId: '' };
  const reflection = { cwd, profileEnabled: false, personaFields: [], conversationId: null,
    route: 'http://127.0.0.1:39218/chat/send', forwardedToOriginalFetch: true,
    requestId: 'request-browser', clientThreadId, messageMatched: true,
    executionPolicy: { mode: 'fixtureBrowserQa' }, browserTransportId: 'root-sse-qa-1',
    rootSseStable: true, rootSseReadyState: 1,
    rootSseSampledAtMs: 1001, rootSseCheckedAtMs: 1002,
    selectedSources: [{ kind: 'browser', sourceId: selection.sourceId,
      cardId: selection.cardId, profileId: selection.profileId,
      uri: fixtureUrl, accountId: '',
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
  const ready = { sourceReady: true, stable: true, eventSourceReadyState: 1,
    browserTransportId: 'root-sse-qa-1', sampledAtMs: 1000 };
  assert.equal(assertFreshBrowserRootSse({ ready, emitted: reflection, now: 1001 }), true);
  assert.throws(() => assertFreshBrowserRootSse({ ready: { ...ready, sourceReady: false },
    emitted: reflection, now: 1001 }), /not received/);
  assert.throws(() => assertFreshBrowserRootSse({ ready: { ...ready, stable: false },
    emitted: reflection, now: 1001 }), /current listener/);
  assert.equal(assertFreshBrowserRootSse({ ready, emitted: reflection, now: 7001 }), true);
  assert.throws(() => assertFreshBrowserRootSse({ ready, now: 7001 }), /stale/);
  assert.throws(() => assertFreshBrowserRootSse({ ready, emitted: { ...reflection,
    browserTransportId: 'other-root' }, now: 1001 }), /did not use/);
  assert.throws(() => assertFreshBrowserRootSse({ ready, emitted: { ...reflection,
    rootSseStable: false }, now: 1001 }), /not stable/);
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
  const readPayload = nativeReadCommand(nativeFile);
  const readNative = nativeZshWrappedCommand(readPayload);
  const printfNative = nativeZshWrappedCommand(harmlessPrintfCommand(commandTag));
  assert.notEqual(digest(readNative), digest(readPayload), 'receipt must hash the full native wrapper');
  value.messages = [{ role: 'assistant', text: `${fileNonce} and ${commandTag}` }];
  value.activities = [
    { id: 'read-1', kind: 'commandExecution', status: 'completed',
      detail: { command: readNative, cwd, exitCode: 0 } },
    { id: 'cmd-2', kind: 'commandExecution', status: 'completed',
      detail: { command: printfNative, cwd, exitCode: 0 } },
  ];
  const baseReceipt = { nativeItemType: 'commandExecution',
    origin: 'codex-app-server.item/completed', originalProviderId: 'codex-native',
    outputStream: 'aggregated-stdout-stderr', nativeItemStatus: 'completed',
    exitCode: 0, status: 'marker-witness', receiptScope: 'single-native-command-item',
    commandHashBasis: 'sanitized-native-item-command', bridgeEpoch: 7,
    contractFingerprint: nativeContractFingerprint };
  const readReceipt = { ...baseReceipt, nativeItemId: 'read-1', markerLines: [fileNonce],
    commandSha256: digest(readNative) };
  const commandReceipt = { ...baseReceipt, nativeItemId: 'cmd-2', markerLines: [commandTag],
    commandSha256: digest(printfNative) };
  value.qaCommandReceipts = [readReceipt, commandReceipt];
  const events = life(value);
  events.splice(2, 0,
    { ...event(value, 'qa.command.receipt', readReceipt, 'read-1'), seq: 3, ts: 230 },
    { ...event(value, 'qa.command.receipt', commandReceipt, 'cmd-2'), seq: 4, ts: 240 });
  events[4] = { ...events[4], seq: 5 };
  const input = { run: value, events, nativeFile,
    readCommand: readPayload,
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
    activities: value.activities.map(item => item.id === 'read-1'
      ? { ...item, detail: { ...item.detail, command: `${readNative}; pwd` } } : item) } }), /file-read command item is missing/);
  assert.throws(() => assertNativeFileAndCommand({ ...input, run: { ...value,
    activities: value.activities.map(item => item.id === 'read-1'
      ? { ...item, detail: { ...item.detail,
        command: nativeZshWrappedCommand(nativeReadCommand(`${cwd}/other.txt`)) } } : item) } }), /file-read command item is missing/);
  assert.throws(() => assertNativeFileAndCommand({ ...input, run: { ...value,
    activities: value.activities.map(item => item.id === 'cmd-2'
      ? { ...item, detail: { ...item.detail, cwd: `${cwd}/other` } } : item) } }), /harmless native command item is missing/);
  assert.throws(() => assertNativeFileAndCommand({ ...input, run: { ...value,
    activities: [...value.activities, { id: 'extra-tool', kind: 'dynamicToolCall' }] } }), /unrequested tool action/);
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
      mode: 'direct', coverage: { sourceTruncated: false },
      deliveryStatus: 'sent-to-app-server' }] };
  const reference = { sourceId: 'source-1', snapshotId: 'source-1', hash: 'original-hash' };
  const stored = { capture: { sourceId: 'source-1', hash: 'original-hash' },
    source: { text: 'QA_SOURCE_earlier' },
    delivered: { packetId: 'packet-1', deliveryStatus: 'sent-to-app-server',
      binding: { conversationId: value.conversationId, runId: value.runId,
        answerId: value.answerId } } };
  const lifecycle = life(value);
  const events = [...lifecycle.slice(0, 2), { ...event(value, 'context.read.completed', {
    sourceId: 'source-1', packetId: 'packet-1', receiptId: 'delivery-1',
    mode: 'direct', deliveryStatus: 'sent-to-app-server' }, 'call-source-1'), seq: 3 },
  { ...lifecycle[2], seq: 5 }];
  const input = { run: value, events, reference, originalNonce: 'QA_SOURCE_earlier',
    changedNonce: 'QA_SOURCE_later', originalHash: 'original-hash', currentHash: 'changed-hash',
    stored, beforeFiles: inventory, afterFiles: structuredClone(inventory),
    changedFile: sourceFile };
  assert.deepEqual(assertSourceRead(input), { sourceId: 'source-1', nativeCallId: 'call-source-1',
    packetId: 'packet-1', readMode: 'direct', readCount: 1 });
  assert.throws(() => assertSourceRead({ ...input, events: life(value) }), /named native/);
  assert.throws(() => assertSourceRead({ ...input, events: events.map(item => item.event === 'context.read.completed'
    ? { ...item, itemId: 'other' } : item) }), /uniquely bound/);
  assert.throws(() => assertSourceRead({ ...input, run: { ...value, activities: [] } }), /named native/);
  assert.throws(() => assertSourceRead({ ...input, stored: { ...stored, source: { text: 'QA_SOURCE_later' } } }), /original nonce/);
  assert.throws(() => assertSourceRead({ ...input, run: { ...value, context: { ...value.context, captures: [] } } }), /exactly one capture/);
  assert.throws(() => assertSourceRead({ ...input, run: { ...value,
    activities: [...value.activities, { id: 'native-read', kind: 'commandExecution' }] } }), /not distinct/);
  assert.throws(() => assertSourceRead({ ...input, run: { ...value, context: { ...value.context,
    packets: [{ ...value.context.packets[0], coverage: { sourceTruncated: true } }] } } }), /SmartRead/);
  const secondPacket = { sourceId: 'source-1', packetId: 'packet-2', receiptId: 'delivery-2',
    mode: 'reader', coverage: { sourceTruncated: false }, deliveryStatus: 'sent-to-app-server' };
  const secondRead = { ...event(value, 'context.read.completed', {
    sourceId: 'source-1', packetId: 'packet-2', receiptId: 'delivery-2',
    mode: 'reader', deliveryStatus: 'sent-to-app-server' }, 'call-source-2'), seq: 4 };
  const twoRun = { ...value, activities: [...value.activities,
    { id: 'call-source-2', kind: 'dynamicToolCall', status: 'completed',
      detail: { tool: 'egdesk_read_source' } }],
    context: { ...value.context, packets: [...value.context.packets, secondPacket] } };
  const twoEvents = [...events.slice(0, -1), secondRead, events.at(-1)];
  const twoStored = { ...stored, delivered: { ...stored.delivered, packetId: 'packet-2' } };
  const twoInput = { ...input, run: twoRun, events: twoEvents, stored: twoStored };
  assert.deepEqual(assertSourceRead(twoInput), { sourceId: 'source-1',
    nativeCallId: 'call-source-2', packetId: 'packet-2', readMode: 'reader', readCount: 2 });
  assert.throws(() => assertSourceRead({ ...twoInput, stored }), /latest delivered packet/);
  assert.throws(() => assertSourceRead({ ...twoInput,
    stored: { ...twoStored, delivered: { ...twoStored.delivered,
      binding: { ...twoStored.delivered.binding, runId: 'another-run' } } } }), /another run/);
  assert.throws(() => assertSourceRead({ ...twoInput, events: events }), /incomplete/);
  assert.throws(() => assertSourceRead({ ...twoInput,
    run: { ...twoRun, context: { ...twoRun.context,
      packets: [...twoRun.context.packets].reverse() } } }), /SSE delivery order/);
  assert.throws(() => assertSourceRead({ ...twoInput,
    run: { ...twoRun, activities: twoRun.activities.filter(item => item.id !== 'call-source-2') } }), /incomplete/);
  assert.throws(() => assertSourceRead({ ...twoInput,
    run: { ...twoRun, context: { ...twoRun.context,
      packets: [twoRun.context.packets[0], { ...secondPacket, coverage: { sourceTruncated: true } }] } } }), /SmartRead/);
});

test('Browser positive maps actual A SSE/native items to one local observe-click-observe-fill run', () => {
  const value = run('turn-browser-positive');
  value.executionPolicy = { mode: 'fixtureBrowserQa', status: 'native-thread-verified',
    sandbox: 'readOnly', networkAccess: false, approvalPolicy: 'never',
    externalMcpCatalog: 'empty', inspectedMcpServers: 0,
    browserEffects: 'attested-local-fixture-only' };
  const fixture = { url: 'http://127.0.0.1:39220/egdesk-qa/QA_URL_0123456789abcdef',
    marker: 'QA_DOM_0123456789abcdef' };
  const selection = { selectedByUser: true, permission: 'interact',
    cardId: 'card-positive', profileId: 'profile-positive', uri: fixture.url,
    accountId: '', sourceId: 'source-positive', cardEpoch: 'card-epoch-positive' };
  value.messages = [{ role: 'assistant', text: `Observed ${fixture.marker} and filled the harmless field.` }];
  value.context = { captures: [{ sourceId: 'capture-positive' }] };
  value.browserBinding = { cards: [{ cardId: selection.cardId, permission: 'interact',
    sourceId: selection.sourceId, cardEpoch: selection.cardEpoch }] };
  const ids = ['observe-1', 'click-1', 'observe-2', 'fill-1'];
  const names = ['egdesk_browser_observe', 'egdesk_browser_click',
    'egdesk_browser_observe', 'egdesk_browser_fill'];
  value.activities = ids.map((id, index) => ({ id, kind: 'dynamicToolCall', status: 'completed',
    detail: { tool: names[index] } }));
  const events = life(value);
  events[2] = { ...events[2], seq: 9 };
  events.splice(2, 0,
    { ...event(value, 'context.bound', { captures: value.context.captures }), seq: 3 },
    { ...event(value, 'browser.bound', value.browserBinding), seq: 4 },
    ...ids.map((id, index) => ({ ...event(value, 'browser.tool.completed', {
      callId: id, cardId: selection.cardId, sourceId: selection.sourceId,
      targetCardEpoch: selection.cardEpoch, bridgeEpoch: 7,
      originalProviderId: 'egdesk-browser', namespace: null,
      status: [0, 2].includes(index) ? 'observed' : 'postcondition-observed',
      ...([0, 2].includes(index) ? { observationId: `obs-${index}` }
        : { action: index === 1 ? 'click' : 'fill', postconditionMatched: true }),
      externalEffectVerified: false,
    }, id), seq: 5 + index })));
  const active = { snapshot: { streamId: 'stream-unit', seq: 2 },
    run: { ...value, status: 'inProgress' } };
  const emitted = { contextSnapshotIds: ['capture-positive'],
    selectedSources: [{ sourceId: selection.sourceId,
      cardEpoch: selection.cardEpoch, uri: fixture.url }] };
  const before = { targetUrl: fixture.url, targetProfileId: selection.profileId,
    targetCardEpoch: selection.cardEpoch, targetAccountId: '',
    targetDocumentId: 'document-positive', targetRevision: 2,
    targetViewport: { width: 800, height: 600, devicePixelRatio: 1 },
    targetSegments: [fixture.marker, 'Waiting for QA action'],
    targetText: 'Waiting for QA action', targetInteractive: [
      { label: 'Reveal QA details', tag: 'button' }, { label: 'QA note', tag: 'input' }],
    inputValue: '', targetInputFocused: false, focusedCardId: null,
    controlText: '', controlInputValue: '', controlCardId: 'control-positive',
    camera: { pan: { x: 0, y: 0 }, zoom: 1, activeEntityId: null },
    cards: ['card-positive', 'control-positive'] };
  const after = { ...before,
    targetRevision: 3,
    targetSegments: [fixture.marker, 'Changed by QA click', 'Newly revealed node'],
    targetText: 'Changed by QA click\nNewly revealed node',
    inputValue: 'harmless QA input', targetInputFocused: false, focusedCardId: null,
    camera: { ...before.camera, activeEntityId: selection.cardId } };
  const input = { run: value, events, active, emitted, cwd, selection, fixture,
    target: { cardId: selection.cardId, profileId: selection.profileId,
      fillValue: 'harmless QA input' }, control: { cardId: 'control-positive' }, before, after };
  assert.deepEqual(browserToolReceipts(value, events).map(call => call.itemId), ids);
  const proof = assertBrowserPositiveFlow(input);
  assert.equal(proof.publicModelToolReceiptsVerified, true);
  assert.equal(proof.independentLocalDomVerified, true);
  assert.equal(proof.independentActorDocumentRevisionVerified, true);
  assert.equal(proof.modelActionGuardRevisionPubliclyVerified, false);
  assert.equal(proof.inputFocusedAfter, false);
  assert.equal(proof.negativeGuardsVerified, false);
  assert.throws(() => assertBrowserPositiveFlow({ ...input,
    events: events.map(item => item.itemId === 'fill-1'
      ? { ...item, details: { ...item.details, postconditionMatched: false } } : item) }), /fill postcondition/);
  assert.throws(() => assertBrowserPositiveFlow({ ...input,
    after: { ...after, targetSegments: ['Changed by QA click'] } }), /fixture marker/);
  assert.throws(() => assertBrowserPositiveFlow({ ...input,
    after: { ...after, targetDocumentId: 'other-document' } }), /document identities/);
  assert.throws(() => assertBrowserPositiveFlow({ ...input,
    after: { ...after, targetRevision: before.targetRevision } }), /revision did not advance/);
  assert.throws(() => assertBrowserPositiveFlow({ ...input,
    after: { ...after, targetViewport: { ...after.targetViewport, width: 700 } } }), /viewport changed/);
  assert.throws(() => assertBrowserPositiveFlow({ ...input,
    after: { ...after, camera: { ...after.camera, pan: { x: 2, y: 0 } } } }), /moved Canvas camera/);
  assert.throws(() => assertBrowserPositiveFlow({ ...input,
    after: { ...after, focusedCardId: 'control-positive' } }), /other than the selected target/);
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
      { callId: item.itemId, originalProviderId: 'egdesk-browser', namespace: null,
        cardId: target.cardId,
        sourceId: selection.sourceId, targetCardEpoch: selection.cardEpoch,
        bridgeEpoch: item.bridgeEpoch,
        ...(item.status === 'rejected' ? { code: item.code } : {
          status: item.kind === 'observe' ? 'observed' : 'postcondition-observed',
          ...(item.kind !== 'observe' ? { action: item.kind, postconditionMatched: true } : {}),
        }) }, item.itemId), seq: 4 + index })));
  const input = { run: value, events, active, calls, selection, target,
    control: { cardId: 'card-control' }, before, after };
  assert.equal(assertPublicBrowserSseBindings(input).publicEventBindingVerified, true);
  assert.throws(() => assertPublicBrowserSseBindings({ ...input,
    events: events.map(item => item.event === 'browser.tool.completed'
      ? { ...item, details: { ...item.details, originalProviderId: 'other' } } : item) }), /another tool provider/);
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
  assert.equal(assertBrowserToolFlow({ ...input,
    after: { ...after, targetInputFocused: false } }).inputFocusedAfter, false);
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

test('owned Browser fixture handler serves only one exact loopback GET with a persistent DOM marker', () => {
  const pathMarker = 'QA_URL_0123456789abcdef';
  const marker = 'QA_DOM_0123456789abcdef';
  const fixture = createBrowserFixtureHandler({ port: 39220, pathMarker, marker });
  assert.equal(fixture.url, `http://127.0.0.1:39220/egdesk-qa/${pathMarker}`);
  const html = browserFixtureHtml(marker);
  assert.ok(html.includes(`<p id="fixture-marker">${marker}</p>`));
  assert.ok(html.includes('Reveal QA details') && html.includes('QA note'));
  assert.equal(html.includes('<form'), false);
  const response = () => ({ status: null, headers: null, body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; } });
  const accepted = response();
  fixture.handle({ method: 'GET', url: `/egdesk-qa/${pathMarker}`,
    headers: { host: '127.0.0.1:39220' } }, accepted);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body, html);
  for (const request of [
    { method: 'GET', url: `/egdesk-qa/${pathMarker}?x=1`, headers: { host: '127.0.0.1:39220' } },
    { method: 'GET', url: `/egdesk-qa/${pathMarker}`, headers: { host: 'localhost:39220' } },
  ]) {
    const denied = response(); fixture.handle(request, denied);
    assert.equal(denied.status, 404);
  }
  const post = response();
  fixture.handle({ method: 'POST', url: `/egdesk-qa/${pathMarker}`,
    headers: { host: '127.0.0.1:39220' } }, post);
  assert.equal(post.status, 405);
  assert.throws(() => createBrowserFixtureHandler({ port: 39218, pathMarker, marker }), /separately leased/);
});

test('Browser fixture preflight accepts only the exact owned HTTP document before any model turn', async () => {
  const fixture = { url: 'http://127.0.0.1:39220/egdesk-qa/QA_URL_0123456789abcdef',
    marker: 'QA_DOM_0123456789abcdef' };
  const response = overrides => ({ status: 200, url: fixture.url,
    headers: { get: () => 'text/html; charset=utf-8' },
    text: async () => browserFixtureHtml(fixture.marker), ...overrides });
  const fetchImpl = async (url, options) => {
    assert.equal(url, fixture.url);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    return response();
  };
  assert.equal(await assertBrowserFixtureServerReady(fixture, fetchImpl), true);
  await assert.rejects(assertBrowserFixtureServerReady(fixture,
    async () => response({ status: 302 })), /did not return 200/);
  await assert.rejects(assertBrowserFixtureServerReady(fixture,
    async () => response({ url: 'http://example.com/' })), /changed URL/);
  await assert.rejects(assertBrowserFixtureServerReady(fixture,
    async () => response({ text: async () => '<html>lookalike</html>' })), /differs/);
});

test('independent fixture recheck catches added, removed and same-content rewritten files', () => {
  assert.equal(assertNoFixtureWrites(inventory, structuredClone(inventory)), true);
  assert.throws(() => assertNoFixtureWrites(inventory, { ...inventory, [`${cwd}/extra.txt`]: {} }), /inventory changed/);
  assert.throws(() => assertNoFixtureWrites(inventory, { [nativeFile]: inventory[nativeFile] }), /inventory changed/);
  assert.throws(() => assertNoFixtureWrites(inventory, { ...inventory,
    [sourceFile]: { ...inventory[sourceFile], ctimeNs: '2' } }), /provider changed/);
});
