import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import {
  parseDeadlineUtc, assertBeforeDeadline, assertTurnTimeBudget, parseCases, scenarioCoverage,
  assertQaExecutionMode, assertNegativeFixtureBackend, assertQaAttachMode, captureBrowserNegativeScreenshot,
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
  browserToolReceipts, assertBrowserPositiveFlow, assertBrowserFocusOwnership, assertBrowserRenderedAnswer,
  installQaSendWitness,
  assertPublicBrowserSseBindings,
  assertBrowserSameChatAddition, assertBrowserNegativeGuards,
  assertBrowserNegativeProbeResults,
  browserViewportChanged,
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

test('constructed POSIX printf actually emits one newline in the local shell',
  { skip: process.platform === 'win32' ? 'POSIX native command receipts; Windows Browser QA uses no shell commands' : false }, () => {
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
    selectedCasesVerified: true, fullScenarioVerified: false, coverage: 'partial',
    missingEvidence: ['native-model-browser', 'native-model-browser-negative'] });
  assert.deepEqual(scenarioCoverage(['native', 'source', 'browser'], ['native', 'source', 'browser']), {
    selectedCasesVerified: true, fullScenarioVerified: false, coverage: 'partial',
    missingEvidence: ['native-model-browser-negative'] });
  assert.deepEqual(scenarioCoverage(['native', 'source', 'browser', 'browser-negative'],
    ['native', 'source', 'browser', 'browser-negative']), {
    selectedCasesVerified: true, fullScenarioVerified: false, coverage: 'partial',
    missingEvidence: ['native-model-browser-negative'] });
  assert.deepEqual(parseCases('browser-negative'), ['browser-negative']);
  assert.deepEqual(scenarioCoverage(['native', 'source'], ['native']), {
    selectedCasesVerified: false, fullScenarioVerified: false, coverage: 'partial',
    missingEvidence: ['native-model-source', 'native-model-browser', 'native-model-browser-negative'] });
  assert.deepEqual(scenarioCoverage(['browser'], ['browser']), {
    selectedCasesVerified: true, fullScenarioVerified: false, coverage: 'partial',
    missingEvidence: ['native-model-native', 'native-model-source', 'native-model-browser-negative'] });
  for (const invalid of [undefined, '', 'native,source,unknown', 'native,native', 'native, source']) {
    assert.throws(() => parseCases(invalid));
  }
});

test('real Browser final answer must reach its native-item-bound visible Chat row', () => {
  const fixture = { marker: 'QA_DOM_0123456789abcdef' };
  const value = { status: 'completed', runId: 'browser-run', conversationId: 'browser-conversation',
    messages: [{ id: 'native-final', role: 'assistant', phase: 'final_answer', status: 'complete',
      text: `Observed ${fixture.marker}` }] };
  const row = { messageId: 'local-final', nativeItemId: 'native-final', role: 'assistant',
    runId: value.runId, status: 'complete', stateText: value.messages[0].text,
    visible: true, text: value.messages[0].text };
  const rendered = { activeThreadId: 'local-thread', conversationId: value.conversationId, rows: [row] };
  const input = { run: value, rendered, threadId: 'local-thread', fixture };
  assert.equal(assertBrowserRenderedAnswer(input).renderedFinalAnswerVerified, true);
  for (const changed of [{ nativeItemId: 'another-native-item' }, { runId: 'another-run' }]) {
    assert.throws(() => assertBrowserRenderedAnswer({ ...input,
      rendered: { ...rendered, rows: [{ ...row, ...changed }] } }), /run-bound rendered/);
  }
  assert.throws(() => assertBrowserRenderedAnswer({ ...input,
    rendered: { ...rendered, rows: [{ ...row, visible: false }] } }), /not visible/);
  assert.throws(() => assertBrowserRenderedAnswer({ ...input,
    rendered: { ...rendered, rows: [{ ...row, stateText: 'different answer' }] } }), /differs/);
  assert.throws(() => assertBrowserRenderedAnswer({ ...input,
    rendered: { ...rendered, activeThreadId: 'another-thread' } }), /another Chat thread/);
});

test('model-free Browser probes require their own gate and exact untouched fixture backend', () => {
  const env = { EGDESK_QA_BROWSER_NEGATIVE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_FIXTURE_TOKEN: 'QA_PUBLIC_TOKEN_0123456789' };
  assert.doesNotThrow(() => assertQaExecutionMode(['browser-negative'], env));
  assert.throws(() => assertQaExecutionMode(['browser-negative'], { ...env, EGDESK_QA_BROWSER_NEGATIVE: '0' }), /NEGATIVE/);
  assert.throws(() => assertQaExecutionMode(['browser-negative'], { ...env, EGDESK_QA_FIXTURE_TRANSPORT: '0' }), /fixture/);
  assert.throws(() => assertQaExecutionMode(['browser'], env), /real-turn/);
  assert.throws(() => assertQaExecutionMode(['browser'], { ...env, EGDESK_QA_REAL_TURN: '1' }), /forbidden/);
  const state = { fixture: true, profile: 'owned-profile', observed: { sends: [], authWrites: [] }, runs: [] };
  const health = { ok: true, fixture: true };
  assert.equal(assertNegativeFixtureBackend('owned-profile', health, state).providerTurns, 0);
  assert.throws(() => assertNegativeFixtureBackend('other-profile', health, state), /another Firefox/);
  assert.throws(() => assertNegativeFixtureBackend('owned-profile', { ...health, fixture: false }, state), /production/);
  for (const key of ['sends', 'authWrites']) assert.throws(() => assertNegativeFixtureBackend('owned-profile', health,
    { ...state, observed: { ...state.observed, [key]: [{}] } }), /zero fixture/);
  assert.throws(() => assertNegativeFixtureBackend('owned-profile', health, { ...state, runs: [{}] }), /Chat run/);
});

const negativeEnv = { EGDESK_QA_BROWSER_NEGATIVE: '1', EGDESK_QA_FIXTURE_TRANSPORT: '1',
  EGDESK_QA_FIXTURE_TOKEN: 'QA_PUBLIC_TOKEN_0123456789', EGDESK_MARIONETTE_PORT: '2829',
  EGDESK_QA_BROWSER_NEGATIVE_HEADLESS: '1' };

test('only gated model-free Browser probes may attach to 2829; provider cases stay on 2828', () => {
  for (const port of ['2828', '2829']) assert.deepEqual(assertQaAttachMode(['browser-negative'],
    { ...negativeEnv, EGDESK_MARIONETTE_PORT: port }), { headlessDiagnostics: true });
  for (const port of [undefined, '2827', '2830', 2829, '02829']) assert.throws(() => assertQaAttachMode(
    ['browser-negative'], { ...negativeEnv, EGDESK_MARIONETTE_PORT: port }), /port 2828/);
  for (const key of ['EGDESK_QA_BROWSER_NEGATIVE', 'EGDESK_QA_FIXTURE_TRANSPORT', 'EGDESK_QA_FIXTURE_TOKEN']) {
    assert.throws(() => assertQaAttachMode(['browser-negative'], { ...negativeEnv, [key]: undefined }));
  }
  assert.throws(() => assertQaAttachMode(['browser-negative', 'browser'], negativeEnv), /separately/);
  for (const cases of [['native'], ['source'], ['browser'], ['native', 'browser']]) {
    const env = { EGDESK_QA_REAL_TURN: '1', EGDESK_MARIONETTE_PORT: '2828' };
    assert.deepEqual(assertQaAttachMode(cases, env), { headlessDiagnostics: false });
    assert.throws(() => assertQaAttachMode(cases, { ...env, EGDESK_MARIONETTE_PORT: '2829' }), /port 2828/);
    assert.throws(() => assertQaAttachMode(cases, { ...env, EGDESK_QA_BROWSER_NEGATIVE_HEADLESS: '1' }), /only for model-free/);
  }
  assert.throws(() => assertQaAttachMode(['browser-negative'],
    { ...negativeEnv, EGDESK_QA_BROWSER_NEGATIVE_HEADLESS: 'yes' }), /invalid headless/);
});

test('headless diagnostic screenshot unsupported is separate from DOM proof and never a visual pass', async () => {
  let profileChecks = 0, captures = 0;
  const harness = { async assertRemoteProfile() { profileChecks++; },
    async evaluateChrome() { return true; }, async screenshot(name) {
    captures++; assert.equal(name, 'browser-guards-verified'); return '/owned/qa.png';
  } };
  assert.deepEqual(await captureBrowserNegativeScreenshot(harness, ['browser-negative'], negativeEnv),
    { status: 'captured', path: '/owned/qa.png', visualPass: null, gfxInfoIsHeadless: true });
  for (const message of ['screenshot_page: Error: unsupported operation: chrome capture unavailable',
    'screenshot_page: Error: Protocol error (browsingContext.captureScreenshot): unsupported operation',
    'screenshot_page: Error: BiDi error: "unsupported operation"']) {
    const unsupported = { ...harness, async screenshot() { throw new Error(message); } };
    assert.deepEqual(await captureBrowserNegativeScreenshot(unsupported, ['browser-negative'], negativeEnv),
      { status: 'unsupported', visualPass: null, errorCode: 'unsupported operation',
        scope: 'headless-screenshot-only', domProbeProofIndependent: true, gfxInfoIsHeadless: true });
    await assert.rejects(captureBrowserNegativeScreenshot(unsupported, ['browser-negative'],
      { ...negativeEnv, EGDESK_QA_BROWSER_NEGATIVE_HEADLESS: undefined }), error => error.message === message);
  }
  for (const message of ['screenshot_page: Error: unknown error', 'screenshot_page: timed out',
    'screenshot_page: Error: unsupported image format', 'unsupported operation',
    'evaluate_privileged_script: unsupported operation',
    'evaluate_privileged_script: Error: BiDi error: "unsupported operation"',
    'screenshot_page: Error: Protocol error (browsingContext.navigate): unsupported operation',
    'screenshot_page: Error: BiDi error: "unknown error"',
    'screenshot_page: Error: BiDi error: "unsupported operation": Refusing different Firefox profile',
    'screenshot_page: Error: BiDi error: "unsupported operation"\nRefusing different Firefox profile',
    'Refusing different Firefox profile: screenshot_page: Error: BiDi error: "unsupported operation"',
    'screenshot_page: Error: BiDi error: "unsupported operation" trailing context',
    'screenshot_page: Error: unknown error: unsupported operation']) {
    await assert.rejects(captureBrowserNegativeScreenshot({ ...harness,
      async screenshot() { throw new Error(message); } }, ['browser-negative'], negativeEnv),
    error => error.message === message);
  }
  const mismatch = new Error('Refusing different Firefox profile');
  await assert.rejects(captureBrowserNegativeScreenshot({ ...harness,
    async assertRemoteProfile() { throw mismatch; } }, ['browser-negative'], negativeEnv), error => error === mismatch);
  assert.equal(captures, 1, 'profile mismatch must fail before attempting screenshot');
  assert.ok(profileChecks > 1);
  await assert.rejects(captureBrowserNegativeScreenshot(harness, ['browser'],
    { EGDESK_QA_REAL_TURN: '1', EGDESK_MARIONETTE_PORT: '2828' }), /simulator-only/);
});

test('headless screenshot gate reads actual gfxInfo before capture and fails closed on false, absent or failed reads', async () => {
  for (const value of [true, false, undefined, null, 'true', 1]) {
    const events = [];
    const gfxInterface = {};
    const harness = {
      async assertRemoteProfile() { events.push('profile'); },
      async evaluateChrome(source) {
        return runInNewContext(`(${source})()`, {
          Ci: { nsIGfxInfo: gfxInterface },
          Cc: { '@mozilla.org/gfx/info;1': { getService(type) {
            assert.equal(type, gfxInterface);
            return { get isHeadless() { events.push('gfxInfo-read'); return value; } };
          } } },
        });
      },
      async screenshot() { events.push('capture'); return '/owned/qa.png'; },
    };
    if (value === true) {
      const result = await captureBrowserNegativeScreenshot(harness, ['browser-negative'], negativeEnv);
      assert.equal(result.gfxInfoIsHeadless, true);
      assert.deepEqual(events, ['profile', 'gfxInfo-read', 'capture']);
    } else {
      await assert.rejects(captureBrowserNegativeScreenshot(harness, ['browser-negative'], negativeEnv), /actual gfxInfo/);
      assert.deepEqual(events, ['profile', 'gfxInfo-read']);
    }
  }
  for (const message of ['gfxInfo unavailable', 'screenshot_page: Error: unsupported operation',
    'screenshot_page: Error: BiDi error: "unsupported operation"']) {
    let captures = 0;
    const failure = new Error(message);
    const harness = { async assertRemoteProfile() {}, async evaluateChrome() { throw failure; },
      async screenshot() { captures++; return '/owned/qa.png'; } };
    await assert.rejects(captureBrowserNegativeScreenshot(harness, ['browser-negative'], negativeEnv), error => error === failure);
    assert.equal(captures, 0, 'headless precheck failure must not enter capture or its fallback');
    assert.deepEqual(await captureBrowserNegativeScreenshot(harness, ['browser-negative'],
      { ...negativeEnv, EGDESK_QA_BROWSER_NEGATIVE_HEADLESS: undefined }),
    { status: 'captured', path: '/owned/qa.png', visualPass: null });
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
  const ordinary = { ...reflection, executionPolicy: { mode: 'browserBounded' }, requestBodyUnmodified: true };
  const ordinaryInput = { ...input, expectedPolicyMode: 'browserBounded' };
  assert.equal(assertBrowserUiRequest(ordinary, ordinaryInput), true);
  for (const requestBodyUnmodified of [false, undefined]) assert.throws(() => assertBrowserUiRequest({
    ...ordinary, requestBodyUnmodified }, ordinaryInput), /unmodified original fetch body/);
  assert.throws(() => assertBrowserUiRequest({ ...ordinary, executionPolicy: undefined }, ordinaryInput), /bounded native/);
  assert.throws(() => assertBrowserUiRequest({ ...ordinary,
    executionPolicy: { mode: 'browserBounded', extra: true } }, ordinaryInput), /exact bounded policy/);
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

test('ordinary Browser witness forwards exact original fetch arguments and never injects policy', async () => {
  const hadWindow = Object.hasOwn(globalThis, 'window'), oldWindow = globalThis.window;
  const hadDocument = Object.hasOwn(globalThis, 'document'), oldDocument = globalThis.document;
  const make = (policyMode = 'browserBounded') => {
    const selected = policyMode === 'browserBounded';
    const source = { id: 'source-witness', kind: 'browser', selectedByUser: true,
      browserToolPermission: 'interact', browserToolSelection: { token: 'token-witness', threadId: 'client-witness' },
      browserToolIdentity: { cardEpoch: 'epoch-witness' },
      sourceRef: { viewId: 'card-witness', profileId: 'profile-witness', accountId: '',
        uri: 'http://127.0.0.1:39220/egdesk-qa/QA_URL_0123456789abcdef' } };
    const expected = { clientThreadId: 'client-witness', localThreadId: 'local-witness',
      cwd: '/owned-qa', message: 'Use the explicitly selected Browser', policyMode,
      qaOutputMarkers: [], sourceIds: selected ? null : [], hiddenMarker: null, conversationId: null,
      selectedCardId: selected ? source.sourceRef.viewId : null,
      selectedSourceId: source.id, selectedProfileId: source.sourceRef.profileId,
      selectedCardEpoch: source.browserToolIdentity.cardEpoch, browserFixtureUrl: source.sourceRef.uri,
      browserTransportId: 'transport-witness', browserTransportSampledAtMs: Date.now() };
    const calls = [];
    const fake = { fetch(input, init) { calls.push({ input, init, body: init.body, receiver: this }); return Promise.resolve({ ok: true }); },
      __egdesk: { state: { activeEntityId: 'chat-card-witness', panTarget: { x: 0, y: 0 }, zoomTarget: 1,
        codex: { activeThreadId: 'local-witness', chatCardEntityId: 'chat-card-witness',
          threads: [{ id: 'local-witness', title: 'QA witness', inputSources: selected ? [source] : [], briefingInputs: [] }] } },
      browserAgentTools: { rootSseReady: () => ({ sourceReady: true, stable: true, eventSourceReadyState: 1,
        browserTransportId: 'transport-witness', sampledAtMs: Date.now() }) } } };
    const body = { requestId: 'request-witness', clientThreadId: expected.clientThreadId,
      message: expected.message, cwd: expected.cwd, profileEnabled: false,
      contextSnapshotIds: selected ? ['capture-witness'] : [],
      ...(selected ? { executionPolicy: { mode: 'browserBounded' }, selectedSources: [source],
        browserTransportId: 'transport-witness' } : {}) };
    globalThis.window = fake;
    globalThis.document = { activeElement: null };
    installQaSendWitness(expected);
    return { fake, expected, calls, body };
  };
  try {
    const good = make();
    const route = 'http://127.0.0.1:39218/chat/send';
    const init = { method: 'POST', body: JSON.stringify(good.body), headers: { 'Content-Type': 'application/json' } };
    const originalBody = init.body;
    await good.fake.fetch(route, init);
    assert.equal(good.calls.length, 1);
    assert.equal(good.calls[0].input, route);
    assert.equal(good.calls[0].init, init);
    assert.equal(good.calls[0].body, originalBody);
    assert.equal(good.calls[0].receiver, good.fake);
    assert.equal(good.fake.__egdeskQaSendInterceptor.snapshot.requestBodyUnmodified, true);
    for (const change of [body => { delete body.executionPolicy; },
      body => { body.executionPolicy = { mode: 'fixtureBrowserQa' }; },
      body => { body.executionPolicy.extra = true; },
      body => { body.qaOutputMarkers = []; }]) {
      const bad = make(); change(bad.body);
      assert.throws(() => bad.fake.fetch(route, { method: 'POST', body: JSON.stringify(bad.body) }),
        /policy|receipt fields|must emit browserBounded/);
      assert.equal(bad.calls.length, 0);
      assert.equal(bad.fake.__egdeskQaSendInterceptor.snapshot, null);
    }
    const native = make('readOnlyQa');
    const nativeInit = { method: 'POST', body: JSON.stringify(native.body) };
    await native.fake.fetch(route, nativeInit);
    assert.notEqual(native.calls[0].init, nativeInit);
    assert.deepEqual(JSON.parse(native.calls[0].body).executionPolicy, { mode: 'readOnlyQa' });
    assert.equal(native.fake.__egdeskQaSendInterceptor.snapshot.requestBodyUnmodified, false);
  } finally {
    if (hadWindow) globalThis.window = oldWindow; else delete globalThis.window;
    if (hadDocument) globalThis.document = oldDocument; else delete globalThis.document;
  }
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
      cardEpoch: selection.cardEpoch, uri: fixture.url }],
    focusAtOriginalFetch: { sampledAtMs: 1200,
      activeEntityId: 'chat-card-positive', chatCardEntityId: 'chat-card-positive',
      focusedBrowserCardId: null, focusedChatCardId: 'chat-card-positive',
      activeElementId: 'chat-send', activeElementTag: 'button',
      pan: { x: 0, y: 0 }, zoom: 1 } };
  const preSendFocus = { sampledAtMs: 1100,
    activeEntityId: selection.cardId, chatCardEntityId: 'chat-card-positive',
    focusedBrowserCardId: null, focusedChatCardId: null,
    activeElementId: 'egd-canvas-viewport', activeElementTag: 'div',
    pan: { x: 0, y: 0 }, zoom: 1 };
  const before = { targetUrl: fixture.url, targetProfileId: selection.profileId,
    targetCardEpoch: selection.cardEpoch, targetAccountId: '',
    targetDocumentId: 'document-positive', targetRevision: 2,
    targetViewport: { width: 800, height: 600, devicePixelRatio: 1 },
    sampledAtMs: 1000,
    targetSegments: [fixture.marker, 'Waiting for QA action'],
    targetText: 'Waiting for QA action', targetInteractive: [
      { label: 'Reveal QA details', tag: 'button' }, { label: 'QA note', tag: 'input' }],
    inputValue: '', targetInputFocused: false, focusedCardId: null,
    controlText: '', controlInputValue: '', controlCardId: 'control-positive',
    camera: { pan: { x: 0, y: 0 }, zoom: 1, activeEntityId: selection.cardId },
    cards: ['card-positive', 'control-positive'] };
  const after = { ...before,
    sampledAtMs: 1300,
    targetRevision: 3,
    targetSegments: [fixture.marker, 'Changed by QA click', 'Newly revealed node'],
    targetText: 'Changed by QA click\nNewly revealed node',
    inputValue: 'harmless QA input', targetInputFocused: false, focusedCardId: null,
    camera: { ...before.camera, activeEntityId: 'chat-card-positive' } };
  const input = { run: value, events, active, emitted, preSendFocus, cwd, selection, fixture,
    target: { cardId: selection.cardId, profileId: selection.profileId,
      fillValue: 'harmless QA input' }, control: { cardId: 'control-positive' }, before, after };
  assert.deepEqual(browserToolReceipts(value, events).map(call => call.itemId), ids);
  const proof = assertBrowserPositiveFlow(input);
  assert.equal(proof.publicModelToolReceiptsVerified, true);
  assert.equal(proof.independentLocalDomVerified, true);
  assert.equal(proof.independentActorDocumentRevisionVerified, true);
  assert.equal(proof.modelActionGuardRevisionPubliclyVerified, false);
  assert.equal(proof.inputFocusedAfter, false);
  assert.equal(proof.focusOwnershipVerified, true);
  assert.equal(proof.humanSendFocusTransition, 'chat-card-activated');
  assert.equal(proof.humanTypingProbeVerified, false);
  assert.equal(proof.negativeGuardsVerified, false);
  const ordinaryPolicy = { ...value.executionPolicy, mode: 'browserBounded',
    browserEffects: 'selected-card-observe-click-fill-this-run' };
  const ordinaryInput = { ...input, expectedPolicyMode: 'browserBounded',
    run: { ...value, executionPolicy: ordinaryPolicy },
    active: { ...active, run: { ...active.run, executionPolicy: ordinaryPolicy } },
    events: events.map(event => event.event === 'run.executionPolicy'
      ? { ...event, details: { executionPolicy: ordinaryPolicy } } : event),
    emitted: { ...emitted, executionPolicy: { mode: 'browserBounded' }, requestBodyUnmodified: true } };
  const ordinaryProof = assertBrowserPositiveFlow(ordinaryInput);
  assert.equal(ordinaryProof.expectedPolicyMode, 'browserBounded');
  assert.equal(ordinaryProof.requestBodyUnmodified, true);
  assert.equal(ordinaryProof.ordinaryUiRequestUnmodified, true);
  for (const requestBodyUnmodified of [false, undefined]) assert.throws(() => assertBrowserPositiveFlow({
    ...ordinaryInput, emitted: { ...ordinaryInput.emitted, requestBodyUnmodified } }), /unmodified original fetch body/);
  assert.throws(() => assertBrowserPositiveFlow({ ...ordinaryInput,
    emitted: { ...ordinaryInput.emitted, executionPolicy: undefined } }), /exact bounded policy/);
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
    after: { ...after, camera: { ...after.camera, pan: { x: 2, y: 0 } } } }), /changed Canvas pan or zoom/);
  assert.throws(() => assertBrowserPositiveFlow({ ...input,
    after: { ...after, focusedCardId: 'control-positive' } }), /changed human Browser keyboard-focus/);
  assert.throws(() => assertBrowserPositiveFlow({ ...input,
    after: { ...after, camera: { ...after.camera,
      activeEntityId: 'control-positive' } } }), /changed the human-selected Canvas entity/);
  assert.throws(() => assertBrowserPositiveFlow({ ...input,
    emitted: { ...emitted, focusAtOriginalFetch: null } }), /do not bracket/);
});

test('Browser focus witness preserves a preexisting human control-Card focus without attributing Chat Send to the model', () => {
  const before = { sampledAtMs: 1000, focusedCardId: 'control-card',
    camera: { activeEntityId: 'control-card', pan: { x: 0, y: 0 }, zoom: 1 } };
  const preSendFocus = { sampledAtMs: 1100, activeEntityId: 'control-card',
    chatCardEntityId: 'chat-card', focusedBrowserCardId: 'control-card',
    pan: { x: 0, y: 0 }, zoom: 1 };
  const atFetch = { sampledAtMs: 1200, activeEntityId: 'control-card',
    chatCardEntityId: 'chat-card', focusedBrowserCardId: 'control-card',
    pan: { x: 0, y: 0 }, zoom: 1 };
  const after = { sampledAtMs: 1300, focusedCardId: 'control-card',
    camera: { activeEntityId: 'control-card', pan: { x: 0, y: 0 }, zoom: 1 } };
  const input = { before, preSendFocus, atFetch, after };
  assert.equal(assertBrowserFocusOwnership(input).humanSendFocusTransition, 'unchanged');
  assert.throws(() => assertBrowserFocusOwnership({ ...input,
    atFetch: { ...atFetch, activeEntityId: 'another-card' } }), /other than the Chat Card/);
  assert.throws(() => assertBrowserFocusOwnership({ ...input,
    after: { ...after, camera: { ...after.camera, activeEntityId: 'another-card' } } }),
  /changed the human-selected Canvas entity/);
  assert.throws(() => assertBrowserFocusOwnership({ ...input,
    after: { ...after, focusedCardId: null } }), /changed human Browser keyboard-focus/);
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

function negativeProbeProof() {
  const names = ['stale-revision-before-ui', 'forbidden-scheme-before-ui',
    'stale-dom-at-actor', 'resized-viewport-at-actor',
    'observe-only-interaction-denied', 'stop-before-first-bind-accept',
    'expired-request-before-actor', 'cancel-before-act',
    'readonly-fill-at-actor', 'disabled-fieldset-fill-at-actor', 'aria-disabled-ancestor-fill-at-actor'];
  const receipts = [
    { code: 'BROWSER_OBSERVATION_STALE', uiActRequests: 0 },
    { code: 'INVALID_BROWSER_TOOL', serviceActRequests: 0, uiProtocolDenied: true, uiProtocolActRequests: 1 },
    { code: 'BROWSER_ACTION_UNVERIFIED', uiActRequests: 1 },
    { code: 'BROWSER_ACTION_UNVERIFIED', uiActRequests: 1 },
    { code: 'BROWSER_INTERACTION_NOT_GRANTED', serviceActRequests: 0,
      uiProtocolDenied: true, uiProtocolActRequests: 1 },
    { code: 'BROWSER_BINDING_STALE', cancelledBeforeBindAccepted: true,
      uiActRequests: 0 },
    { code: null, uiStatus: 'rejected', uiReason: 'request expired', requestDeadlineMs: 90, uiActRequests: 1,
      attemptedAt: 100, uiRequestId: 'act-6' },
    { code: 'BROWSER_RUN_ENDED', uiStatus: 'rejected', uiReason: 'run cancelled', serviceActRequestsAfterCancel: 0, uiActRequests: 1,
      attemptedAt: 102, uiRequestId: 'act-7', cancelReceipt: { requestId: 'cancel-7', runId: 'qa-browser-simulator-7',
        cardId: 'owned-local-card', status: 'cancelled', at: 101 } },
    ...Array.from({ length: 3 }, () => ({ code: null, uiActRequests: 1 })),
  ];
  const fixture = { url: 'http://127.0.0.1:39220/egdesk-qa/QA_URL_0123456789abcdef', marker: 'QA_DOM_0123456789abcdef' };
  const snapshot = (elements = []) => ({ cardId: 'owned-local-card', documentId: 'actor-owned',
    url: fixture.url, revision: 1, viewport: { width: 800, height: 600, devicePixelRatio: 1 },
    text: [fixture.marker], focusedElement: null, interactiveElements: elements });
  const guard = (before, target) => ({ documentId: before.documentId, url: before.url,
    revision: before.revision, viewport: before.viewport, focusedRef: null, target });
  const diagnostic = (actionType, phase, status) => ({ cardId: 'owned-local-card', actionType, phase, status, sampledAtMs: 102 });
  const guardedActorPositiveControls = ['fill', 'click'].map(action => {
    const target = { ref: `el-${action}`, label: action === 'fill' ? 'QA note' : 'Reveal QA details',
      tag: action === 'fill' ? 'input' : 'button', disabled: false, value: '' };
    const before = snapshot([target]), after = structuredClone(before);
    const value = action === 'fill' ? 'QA_GUARDED_FILL_CONTROL' : 'QA click count: 2';
    if (action === 'fill') after.interactiveElements[0].value = value;
    else { after.text.push(value); after.revision++; }
    const counter = performCalls => ({ kind: 'actor-perform-entry', actorDocumentId: 'actor-owned', performCalls });
    const uiRequest = (kind, status, at) => ({ kind, status, requestId: `${action}-${kind}`,
      responseRequestId: `${action}-${kind}`, runId: `qa-browser-simulator-${action}`, cardId: 'owned-local-card',
      targetCardEpoch: 'card-epoch-owned', attemptedAt: at, respondedAt: at + 3 });
    return { action, cardId: 'owned-local-card', simulatorOnly: true, sourceId: `source-${action}`,
      cardEpoch: 'card-epoch-owned', syntheticRunId: `qa-browser-simulator-${action}`,
      observed: { status: 'observed', cardId: 'owned-local-card', observationId: `before-${action}`, snapshot: before },
      afterObserved: { status: 'observed', cardId: 'owned-local-card', observationId: `after-${action}`, snapshot: after },
      beforeAttempt: { ...before, qaDiagnostics: counter(1) }, afterAttempt: { ...after, qaDiagnostics: counter(2) },
      receipt: { status: 'postcondition-observed', cardId: 'owned-local-card', action, externalEffectVerified: false,
        after, dispatchReceipt: { actor: 'JSWindowActor', eventDispatched: true, documentStillCurrent: true,
          ...(action === 'click' ? { clickInputRoute: 'dom-click-no-pointerdown', targetClickObserved: true } : {}) },
        postcondition: { kind: action === 'fill' ? 'target-value' : 'visible-text', value, matched: true, wasAlreadyTrue: false } },
      uiRequests: [{ ...uiRequest('act', 'acted', 100), action: { type: action, ref: target.ref,
        ...(action === 'fill' ? { text: value } : {}) }, guard: guard(before, target),
        actorDiagnostic: diagnostic(action, 'post-actor', 'acted') }, uiRequest('observe', 'observed', 104)] };
  });
  const proof = { simulatorOnly: true, nativeModelOriginVerified: false,
    actorPhysicalDispatchCounterVerified: false,
    actorPerformCounterVerified: true, actorPerformPositiveControl: { cardId: 'owned-local-card',
      actorDocumentId: 'actor-owned', before: 0, after: 1 },
    providerTurns: 0, cardId: 'owned-local-card', fixture, guardedActorPositiveControls,
    probes: names.map((name, index) => ({ name, cardId: 'owned-local-card', denied: true,
      ownedFixtureContentUnchangedAfterDeniedAction: true, simulatorOnly: true,
      sourceId: `qa-source-${index}`, cardEpoch: 'card-epoch-owned',
      syntheticRunId: `qa-browser-simulator-${index}`,
      actorDocumentId: 'actor-owned', actorPerformCallsBefore: 1, actorPerformCallsAfter: 1,
      beforeAttempt: { documentId: 'actor-owned', actorPerformCalls: 1, text: 'unchanged' },
      afterAttempt: { documentId: 'actor-owned', actorPerformCalls: 1, text: 'unchanged' },
      uiRequests: [
        ...(index === 7 ? [{ kind: 'cancel', requestId: 'cancel-7', responseRequestId: 'cancel-7',
          runId: 'qa-browser-simulator-7', cardId: 'owned-local-card', targetCardEpoch: 'card-epoch-owned',
          deadlineMs: 1000, attemptedAt: 100, respondedAt: 101, status: 'cancelled' }] : []),
        { kind: [0, 5].includes(index) ? 'bind' : 'act', requestId: `act-${index}`, responseRequestId: `act-${index}`,
          runId: `qa-browser-simulator-${index}`, cardId: 'owned-local-card', targetCardEpoch: 'card-epoch-owned',
          deadlineMs: index === 6 ? 90 : 1000, attemptedAt: index === 7 ? 102 : 100,
          respondedAt: 103, status: [0, 5].includes(index) ? 'bound' : 'rejected', error: 'owned UI guard denied action' }],
      ...receipts[index] })),
    requestsScopedToOwnedCard: true, preexistingBrowserCardStylesUnchanged: true,
    canvasPanZoomUnchanged: true };
  for (const [offset, label] of ['QA readonly note', 'QA fieldset note', 'QA ancestor note'].entries()) {
    const item = proof.probes[8 + offset];
    const target = { ref: `el-denied-${offset}`, tag: 'input', label, disabled: offset !== 0, value: '' };
    item.beforeAttempt = { ...snapshot([target]), actorPerformCalls: 1 };
    item.afterAttempt = structuredClone(item.beforeAttempt);
    Object.assign(item.uiRequests[0], { action: { type: 'fill', ref: target.ref, text: 'QA_CHILD_DENIAL_MUST_NOT_FILL' },
      guard: guard(item.beforeAttempt, target), actorDiagnostic: diagnostic('fill', 'actor', 'rejected'),
      error: offset === 0 ? 'Browser target is not an editable field; observe again' : 'Browser target is unavailable; observe again' });
  }
  return proof;
}

test('actual negative-probe result cannot claim a native model turn or skip an owned no-effect denial', () => {
  const proof = negativeProbeProof();
  assert.equal(assertBrowserNegativeProbeResults(proof), true);
  assert.throws(() => assertBrowserNegativeProbeResults({ ...proof, actorPerformCounterVerified: false }), /perform-entry counter/);
  assert.throws(() => assertBrowserNegativeProbeResults({ ...proof,
    actorPerformPositiveControl: { ...proof.actorPerformPositiveControl, after: 0 } }), /positive action/);
  assert.throws(() => assertBrowserNegativeProbeResults({ ...proof,
    probes: proof.probes.map((item, index) => index === 2 ? { ...item, actorPerformCallsAfter: 2 } : item) }), /perform dispatcher/);
  assert.throws(() => assertBrowserNegativeProbeResults({ ...proof,
    probes: proof.probes.map((item, index) => index === 3 ? { ...item,
      uiRequests: item.uiRequests.map(request => ({ ...request, responseRequestId: 'other-request' })) } : item) }), /correlation/);
  assert.throws(() => assertBrowserNegativeProbeResults({ ...proof,
    probes: proof.probes.map((item, index) => index === 2 ? { ...item,
      uiRequests: item.uiRequests.map(request => ({ ...request, kind: 'bind', status: 'bound' })) } : item) }), /act receipt count/);
  assert.throws(() => assertBrowserNegativeProbeResults({ ...proof,
    nativeModelOriginVerified: true }), /cannot claim native-model origin/);
  assert.throws(() => assertBrowserNegativeProbeResults({ ...proof,
    actorPhysicalDispatchCounterVerified: true }), /unpublished physical-dispatch counter/);
  assert.throws(() => assertBrowserNegativeProbeResults({ ...proof,
    probes: proof.probes.slice(1) }), /incomplete/);
  assert.throws(() => assertBrowserNegativeProbeResults({ ...proof,
    probes: proof.probes.map((item, index) => index === 3
      ? { ...item, ownedFixtureContentUnchangedAfterDeniedAction: false } : item) }), /no-effect/);
  assert.throws(() => assertBrowserNegativeProbeResults({ ...proof,
    preexistingBrowserCardStylesUnchanged: false }), /preexisting Browser Card/);
});

for (const action of ['fill', 'click']) {
  test(`guarded ${action} control rejects missing guard, stale/current-document claims and unobserved effects`, () => {
    const corruptions = [
      item => { item.uiRequests[0].guard = undefined; },
      item => { item.uiRequests[0].guard.revision++; },
      item => { item.uiRequests[0].action.selector = '#qa-input'; },
      item => { item.uiRequests[0].responseRequestId = 'other-request'; },
      item => { item.uiRequests[0].targetCardEpoch = 'other-epoch'; },
      item => { item.uiRequests[0].status = 'rejected'; },
      item => { item.uiRequests[0].actorDiagnostic.phase = 'preflight'; },
      item => { item.uiRequests[0].actorDiagnostic.sampledAtMs = 99; },
      item => { item.afterObserved.observationId = item.observed.observationId; },
      item => { item.uiRequests.pop(); },
      item => { item.uiRequests[1].attemptedAt = 100; },
      item => { item.afterAttempt.qaDiagnostics.performCalls = 1; },
      item => { item.afterAttempt.qaDiagnostics.performCalls = 3; },
      item => { item.receipt.dispatchReceipt.actor = 'simulated'; },
      item => { item.receipt.dispatchReceipt.eventDispatched = false; },
      item => { item.receipt.dispatchReceipt.documentStillCurrent = false; },
      item => { item.receipt.after.documentId = 'old-document'; },
      item => { item.afterAttempt.url = 'http://127.0.0.1:39220/egdesk-qa/QA_URL_otherfixture00'; },
      item => { item.afterAttempt.text = []; },
      item => { item.receipt.postcondition.wasAlreadyTrue = true; },
      item => { item.receipt.externalEffectVerified = true; },
      item => { item.afterAttempt = structuredClone(item.beforeAttempt);
        item.afterAttempt.qaDiagnostics.performCalls++; },
    ];
    if (action === 'click') corruptions.push(
      item => { item.receipt.dispatchReceipt.clickInputRoute = 'native-pointer'; },
      item => { item.receipt.dispatchReceipt.targetClickObserved = false; });
    for (const corrupt of corruptions) {
      const proof = negativeProbeProof();
      corrupt(proof.guardedActorPositiveControls.find(item => item.action === action));
      assert.throws(() => assertBrowserNegativeProbeResults(proof), undefined, corrupt.toString());
    }
    const missing = negativeProbeProof();
    missing.guardedActorPositiveControls = missing.guardedActorPositiveControls.filter(item => item.action !== action);
    assert.throws(() => assertBrowserNegativeProbeResults(missing), /positive controls are incomplete/);
  });
}

for (const name of ['readonly-fill-at-actor', 'disabled-fieldset-fill-at-actor', 'aria-disabled-ancestor-fill-at-actor']) {
  test(`${name} requires the guarded Child phase, exact reason and unchanged independent perform/content evidence`, () => {
    const corruptions = [
      item => { item.uiRequests[0].actorDiagnostic.phase = 'preflight'; },
      item => { item.uiRequests[0].actorDiagnostic.status = 'acted'; },
      item => { item.uiRequests[0].actorDiagnostic.cardId = 'other-card'; },
      item => { item.uiRequests[0].actorDiagnostic.sampledAtMs = 104; },
      item => { item.uiRequests[0].guard = null; },
      item => { item.uiRequests[0].guard.url = 'https://example.com/'; },
      item => { item.uiRequests[0].action.selector = 'input'; },
      item => { item.uiRequests[0].error = 'Browser observation is stale; observe again'; },
      item => { item.actorPerformCallsAfter++; },
      item => { item.afterAttempt.interactiveElements[0].value = 'unexpected fill'; },
      item => { item.afterAttempt.focusedElement = { ref: 'other-target' }; },
      item => { item.beforeAttempt.interactiveElements[0].disabled = !item.beforeAttempt.interactiveElements[0].disabled;
        item.afterAttempt = structuredClone(item.beforeAttempt); },
    ];
    for (const corrupt of corruptions) {
      const proof = negativeProbeProof();
      corrupt(proof.probes.find(item => item.name === name));
      assert.throws(() => assertBrowserNegativeProbeResults(proof), undefined, corrupt.toString());
    }
  });
}

test('Browser resize observes height-only and device-scale changes even when Windows keeps the same inner width', () => {
  const before = { width: 1440, height: 870, devicePixelRatio: 1 };
  assert.equal(browserViewportChanged(before, { ...before }), false);
  assert.equal(browserViewportChanged(before, { ...before, height: 997 }), true);
  assert.equal(browserViewportChanged(before, { ...before, width: 1320 }), true);
  assert.equal(browserViewportChanged(before, { ...before, devicePixelRatio: 1.25 }), true);
  assert.equal(browserViewportChanged(before, null), false);
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
  assert.match(html, /<input aria-label="QA readonly note"[^>]* readonly /);
  assert.match(html, /<fieldset disabled[^>]*><input aria-label="QA fieldset note"[^>]*><\/fieldset>/);
  assert.match(html, /<div aria-disabled="true"><input aria-label="QA ancestor note"[^>]*><\/div>/);
  // The inherited-disabled controls must not accidentally become native
  // disabled inputs: these cases specifically exercise ancestor traversal.
  for (const label of ['QA fieldset note', 'QA ancestor note']) {
    const input = html.match(new RegExp(`<input aria-label="${label}"[^>]*>`))[0];
    assert.doesNotMatch(input, /\s(?:disabled|readonly)(?:\s|=|>)/);
  }
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

test('fixture click marker changes only in its content script and preserves the original stale-DOM setup', () => {
  const html = browserFixtureHtml('QA_DOM_0123456789abcdef');
  let click;
  const children = [];
  const nodes = { 'qa-state': { textContent: 'Waiting for QA action' },
    'qa-click-count': { textContent: 'QA click count: 0' },
    'qa-button': { addEventListener(type, callback) { assert.equal(type, 'click'); click = callback; } },
    'qa-changed': { appendChild(node) { children.push(node); } } };
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], { document: {
    getElementById(id) { assert.ok(nodes[id], `content script escaped fixture node: ${id}`); return nodes[id]; },
    createElement(tag) { assert.equal(tag, 'p'); return { textContent: '' }; },
  } });
  assert.equal(nodes['qa-click-count'].textContent, 'QA click count: 0');
  click();
  assert.equal(nodes['qa-state'].textContent, 'Changed by QA click');
  assert.equal(children[0].textContent, 'Newly revealed node');
  assert.equal(nodes['qa-click-count'].textContent, 'QA click count: 1');
  click();
  assert.equal(nodes['qa-click-count'].textContent, 'QA click count: 2');
  assert.equal(children.length, 2);
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
