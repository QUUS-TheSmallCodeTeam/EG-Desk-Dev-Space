import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { claudeFixtureOptions, assertClaudeFixturePeer, assertClaudeReady, assertSessionOffer,
  assertClaudeQuestionUi, selectClaudeQuestionAnswers, assertClaudeAnswers, assertNoAutomaticRequests,
  assertClaudeContextBlocked, assertClaudeRateUi, CLAUDE_CONTEXT_ERROR, observeClaudeUi,
  selectClaudeInOpenEnginePicker, observeEnginePickerAnchor, assertEnginePickerAnchor,
  CLAUDE_READER_ERROR, assertClaudeReaderBlocked, assertClaudeContextRoute, assertClaudeContextCapture,
  assertClaudeImmutablePacket, selectClaudeAttachment, observeAttachmentChoices,
  observeClaudeContextInspector, assertClaudeContextInspector, observeClaudeFixtureViewport,
  assertClaudeReaderDescriptor, assertClaudeReaderProcessed, assertClaudeReaderPacket, assertClaudeReaderEnded,
  claudeReaderPartialCaptureLabel,
  claudeFixtureCameraSettled, claudeFixtureChatNavigable, returnClaudeChatAfterFixtureSetup } from './verify-firefox-mcp-claude-fixture-flow.mjs';
import { claudeFixtureEngines, CLAUDE_FIXTURE_QUESTIONS } from './egdesk-chat-fixture-transport.mjs';
import { fingerprintQaBytes } from './egdesk-context-qa-contract.mjs';
import { createChatProtocolState, mergeChatSnapshot, claudeContextSendErrorText } from '../overlay/resources/EGDeskChatState.sys.mjs';

const clone = value => structuredClone(value);
const NOW = Date.parse('2026-10-25T12:00:00Z');
const ENV = { EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_FIXTURE_PORT: '39220', EGDESK_QA_CLAUDE_FIXTURE: '1',
  EGDESK_QA_FIXTURE_TOKEN: 'unit-claude-fixture-token', EGDESK_QA_REAL_TURN: '0', MOZ_HEADLESS: '1' };
const ARGS = ['--profile', '/private/tmp/egdesk-chat-test-unit'];
const INPUT = { userInputId: 'input:qa:0:string:claude-question', kind: 'userInput', status: 'pending',
  itemId: 'question-item', isBlocking: true, questions: clone(CLAUDE_FIXTURE_QUESTIONS) };

test('Claude CLI supports Main profile-only and explicit UTC deadline without weakening safe mode', () => {
  const options = claudeFixtureOptions(ARGS, ENV, NOW);
  assert.equal(options.deadlineMs, NOW + 360000);
  assert.equal(options.bridge.origin, 'http://127.0.0.1:39220');
  assert.equal(claudeFixtureOptions([...ARGS, '--deadline-utc', '2026-10-25T12:06:00Z'], ENV, NOW).deadlineMs, NOW + 360000);
  for (const args of [[], ['--profile', 'relative'], [...ARGS, '--profile', '/private/tmp/other'],
    [...ARGS, '--unknown', '1'], [...ARGS, '--deadline-utc'], [...ARGS, '--deadline-utc', '2026-10-25T12:00:00Z'],
    [...ARGS, '--deadline-utc', '2026-10-25T12:20:00Z'], [...ARGS, '--deadline-utc', '2026-10-25T21:06:00+09:00']]) {
    assert.throws(() => claudeFixtureOptions(args, ENV, NOW));
  }
  for (const change of [{ EGDESK_QA_FIXTURE_TRANSPORT: '0' }, { EGDESK_QA_FIXTURE_PORT: undefined },
    { EGDESK_QA_FIXTURE_PORT: '39218' }, { EGDESK_QA_FIXTURE_PORT: '2829' }, { EGDESK_QA_FIXTURE_PORT: '6001' },
    { EGDESK_QA_CLAUDE_FIXTURE: undefined }, { EGDESK_QA_CLAUDE_FIXTURE: '0' }, { EGDESK_QA_REAL_TURN: '1' },
    { MOZ_HEADLESS: '0' }, { EGDESK_MARIONETTE_PORT: '2828' }, { EGDESK_QA_FIXTURE_TOKEN: 'short' }]) {
    assert.throws(() => claudeFixtureOptions(ARGS, { ...ENV, ...change }, NOW));
  }
});

test('peer identity requires the exact isolated profile, port, loopback origin and Claude fixture mode', () => {
  const options = claudeFixtureOptions(ARGS, ENV, NOW);
  const peer = { fixture: true, claudeFixture: true, providerTurns: 0, profile: options.profile,
    host: options.bridge.host, port: options.bridge.port, origin: options.bridge.origin };
  assertClaudeFixturePeer(peer, options);
  for (const change of [{ profile: '/private/tmp/foreign' }, { port: 39218 }, { origin: 'http://localhost:39220' },
    { host: '0.0.0.0' }, { fixture: false }, { claudeFixture: false }, { providerTurns: 1 }]) {
    assert.throws(() => assertClaudeFixturePeer({ ...peer, ...change }, options));
  }
});

test('B3 verifier requires matching explicit synthetic opt-in, scoped port and real-turn zero; B2 remains the default', () => {
  assert.equal(claudeFixtureOptions(ARGS, ENV, NOW).readerMode, 'unavailable');
  const env = { ...ENV, EGDESK_QA_CLAUDE_READER_FIXTURE: '1' };
  const args = [...ARGS, '--reader-mode', 'synthetic'];
  const options = claudeFixtureOptions(args, env, NOW);
  assert.equal(options.readerMode, 'synthetic');
  for (const [argv, environment] of [[ARGS, env], [args, ENV], [[...ARGS, '--reader-mode', 'real'], env],
    [args, { ...env, EGDESK_QA_REAL_TURN: undefined }], [args, { ...env, EGDESK_QA_REAL_TURN: '1' }],
    [args, { ...env, EGDESK_QA_FIXTURE_PORT: '49318' }], [ARGS, { ...ENV, EGDESK_QA_CLAUDE_READER_FIXTURE: 'true' }]]) {
    assert.throws(() => claudeFixtureOptions(argv, environment, NOW));
  }
  const peer = { fixture: true, claudeFixture: true, claudeReaderFixture: true, providerTurns: 0,
    profile: options.profile, host: options.bridge.host, port: options.bridge.port, origin: options.bridge.origin };
  assertClaudeFixturePeer(peer, options);
  assert.throws(() => assertClaudeFixturePeer({ ...peer, claudeReaderFixture: false }, options));
  assert.throws(() => assertClaudeFixturePeer(peer, claudeFixtureOptions(ARGS, ENV, NOW)));
});

test('normal Claude proof rejects synthetic Codex login and requires one stored signed-in Claude profile', () => {
  const state = { appServerReady: false, auth: { isLoggedIn: false }, engines: claudeFixtureEngines() };
  assertClaudeReady(state);
  for (const mutate of [row => { row.auth.isLoggedIn = true; }, row => { row.appServerReady = true; },
    row => { row.engines[0].status = 'ready'; }, row => { row.engines[1].status = 'offline'; },
    row => { row.engines[1].profiles[0].auth.status = 'signedOut'; },
    row => { row.engines[1].profiles.push(clone(row.engines[1].profiles[0])); }]) {
    const changed = clone(state); mutate(changed); assert.throws(() => assertClaudeReady(changed));
  }
});

test('session approval proof needs an offered exact bounded rule, never a persistent or unoffered grant', () => {
  const approval = { kind: 'commandExecution', status: 'pending', choices: ['accept', 'acceptForSession', 'decline', 'cancel'],
    command: "printf 'QA Claude fixture only'" };
  const offer = { synthetic: true, adapterExecutionVerified: false, choices: [...approval.choices],
    sessionRule: { type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'Bash', ruleContent: approval.command }] } };
  assertSessionOffer(approval, offer, true);
  for (const mutate of [row => { row.sessionRule.destination = 'userSettings'; }, row => { row.sessionRule.rules[0].ruleContent = '*'; },
    row => { row.sessionRule.rules = []; }, row => { row.sessionRule.behavior = 'deny'; }, row => { row.sessionRule = null; },
    row => { row.adapterExecutionVerified = true; }, row => { row.choices = ['accept']; }]) {
    const changed = clone(offer); mutate(changed); assert.throws(() => assertSessionOffer(approval, changed, true));
  }
  const noSession = { ...approval, choices: ['accept', 'decline', 'cancel'] };
  const noOffer = { ...offer, choices: [...noSession.choices], sessionRule: null };
  assertSessionOffer(noSession, noOffer, false);
  assert.throws(() => assertSessionOffer(noSession, noOffer, true));
});

const anchorBox = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, visible: true });
const anchoredPicker = () => ({ activeThreadId: 'qa-thread', pickerThreadId: 'qa-thread', panelCount: 1, expandedChipCount: 1,
  sameCard: true, viewport: anchorBox(0, 0, 1200, 800), card: anchorBox(500, 100, 400, 600),
  chip: anchorBox(780, 140, 80, 24), panel: anchorBox(600, 170, 260, 260) });

function enginePickerHarness({ panelCount = 1, choiceCount = 1, pickerThreadId = 'qa-thread', activeThreadId = 'qa-thread',
  visibleChoice = true, disabled = false, anchor = anchoredPicker() } = {}) {
  const picker = '[data-testid="chat-engine-panel"][role="dialog"][aria-label="AI 엔진 설정"]';
  const choice = '[data-testid="chat-engine-choice"][data-engine="claude"]';
  const clicks = [];
  const inside = Array.from({ length: choiceCount }, () => ({ visible: visibleChoice, disabled }));
  return { clicks, picker, choice,
    async inspect(selector) {
      if (selector === picker) return Array.from({ length: panelCount }, () => ({ visible: true }));
      if (selector === `${picker} ${choice}`) return inside;
      if (selector === choice) return [{ visible: true, disabled: false }, ...inside]; // Empty-chat choice also exists.
      throw new Error(`Unexpected selector: ${selector}`);
    },
    async evaluateChrome() { return { ...anchor, activeThreadId, pickerThreadId }; },
    async click(selector) { clicks.push(selector); assert.equal(selector, `${picker} ${choice}`); },
  };
}

test('engine selection scopes the actual open QA picker, excluding the duplicate empty-chat choice', async () => {
  const harness = enginePickerHarness();
  assert.equal((await harness.inspect(harness.choice)).length, 2, 'Reproduce the original selector ambiguity');
  await selectClaudeInOpenEnginePicker(harness, 'qa-thread');
  assert.deepEqual(harness.clicks, [`${harness.picker} ${harness.choice}`]);
});

test('engine selection refuses ambiguous, foreign, absent or disabled picker choices without first-match fallback', async () => {
  for (const options of [{ panelCount: 2 }, { choiceCount: 2 }, { choiceCount: 0 }, { pickerThreadId: 'foreign' },
    { activeThreadId: 'foreign' }, { pickerThreadId: null }, { visibleChoice: false }, { disabled: true }]) {
    const harness = enginePickerHarness(options);
    await assert.rejects(selectClaudeInOpenEnginePicker(harness, 'qa-thread'));
    assert.deepEqual(harness.clicks, [], JSON.stringify(options));
  }
});

test('engine anchor accepts measured below/above placement and viewport clamping at different scales', () => {
  const below = anchoredPicker();
  assert.equal(assertEnginePickerAnchor(below, 'qa-thread').placement, 'below');
  const above = anchoredPicker();
  above.chip = anchorBox(780, 660, 80, 24);
  above.panel = anchorBox(600, 394, 260, 260);
  assert.equal(assertEnginePickerAnchor(above, 'qa-thread').placement, 'above');
  const clamped = anchoredPicker();
  clamped.card = anchorBox(0, 100, 400, 600);
  clamped.chip = anchorBox(20, 140, 80, 24);
  clamped.panel = anchorBox(8, 170, 260, 260);
  for (const original of [below, above, clamped]) for (const scale of [0.5, 0.96, 1.5, 2]) {
    const scaled = clone(original);
    for (const key of ['panel', 'chip', 'card', 'viewport']) {
      const rect = original[key];
      scaled[key] = anchorBox(rect.left * scale, rect.top * scale, rect.width * scale, rect.height * scale);
    }
    assertEnginePickerAnchor(scaled, 'qa-thread');
  }
});

test('engine anchor rejects the observed far-left regression, drift, overlap, clipping and wrong-card geometry', () => {
  for (const mutate of [
    row => { row.panel = anchorBox(0, 298, 260, 260); row.chip = anchorBox(840, 202, 80, 24); row.card = anchorBox(560, 160, 406, 578); },
    row => { row.panel = anchorBox(600, 220, 260, 260); },
    row => { row.panel = anchorBox(600, 145, 260, 260); },
    row => { row.panel = anchorBox(950, 170, 260, 260); },
    row => { row.panel = anchorBox(600, -10, 260, 260); },
    row => { row.chip = anchorBox(-10, 140, 80, 24); },
    row => { row.card = anchorBox(0, 100, 400, 600); },
    row => { row.sameCard = false; }, row => { row.panelCount = 2; }, row => { row.expandedChipCount = 2; },
    row => { row.panel.visible = false; }, row => { row.panel.width = NaN; }, row => { row.chip.height = 0; },
  ]) {
    const changed = anchoredPicker(); mutate(changed);
    assert.throws(() => assertEnginePickerAnchor(changed, 'qa-thread'));
  }
});

test('opened panel is captured before any choice click, including a bad anchor that must stop selection', async () => {
  for (const valid of [true, false]) {
    const anchor = anchoredPicker();
    if (!valid) anchor.panel = anchorBox(0, 298, 260, 260);
    const harness = enginePickerHarness({ anchor });
    const captured = [];
    const selecting = selectClaudeInOpenEnginePicker(harness, 'qa-thread', async observed => {
      assert.deepEqual(harness.clicks, [], 'Screenshot must precede native selection');
      captured.push(clone(observed));
    });
    if (valid) await selecting; else await assert.rejects(selecting);
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0], anchor);
    assert.equal(harness.clicks.length, valid ? 1 : 0);
  }
  assert.doesNotMatch(observeEnginePickerAnchor.toString(), /\.click\(|dispatchEvent|scrollIntoView|\.style\.[a-z]+\s*=/);
});

function questionCard() {
  return { id: INPUT.userInputId, status: 'pending', text: INPUT.questions.map(question =>
    [question.header, question.question, ...question.options.flatMap(option => [option.label, option.description])].join(' ')).join(' '),
  options: INPUT.questions.flatMap(question => question.options.map((option, index) => ({ questionId: question.questionId,
    optionIndex: String(index), type: question.multiSelect ? 'checkbox' : 'radio', checked: false, disabled: false }))) };
}

test('question proof inspects actual checkbox/radio types and drives only three scoped MCP clicks', async () => {
  const card = questionCard();
  assertClaudeQuestionUi(INPUT, card);
  for (const mutate of [row => { row.options[0].type = 'radio'; }, row => { row.options[3].type = 'checkbox'; },
    row => { row.options[1].disabled = true; }, row => { row.options.pop(); }, row => { row.text = 'question title only'; }]) {
    const changed = clone(card); mutate(changed); assert.throws(() => assertClaudeQuestionUi(INPUT, changed));
  }
  const clicks = [];
  await selectClaudeQuestionAnswers({ async click(selector) { clicks.push(selector); } }, INPUT);
  assert.equal(clicks.length, 3);
  assert.ok(clicks.every(selector => selector.startsWith('#egd-codex-activity-panel ') && selector.includes(INPUT.userInputId)));
  assert.deepEqual(clicks.map(selector => selector.match(/data-question-id="(q\d)"\]\[data-option-index="(\d)"/).slice(1)),
    [['q0', '0'], ['q0', '2'], ['q1', '1']]);
});

test('fresh empty protocol restoration retains Claude identity and complete multiSelect questions', () => {
  const state = createChatProtocolState();
  const snapshot = { streamId: 'qa-claude', seq: 7, connection: 'ready', conversationId: 'claude-conversation', engineId: 'claude',
    historyComplete: true, truncated: false, runs: [{ runId: 'run-1', engineId: 'claude', engine: { id: 'claude', engineProfileId: 'claude-default' },
      status: 'inProgress', messages: [], activities: [], artifacts: [], pendingApprovals: [], pendingUserInputs: [INPUT] }] };
  const frozen = JSON.stringify(snapshot);
  const [run] = mergeChatSnapshot(state, snapshot, 'qa-claude-client');
  assert.equal(run.engineId, 'claude');
  assert.deepEqual(run.pendingUserInputs[0].questions, CLAUDE_FIXTURE_QUESTIONS);
  assert.equal(run.clientThreadId, 'qa-claude-client');
  assert.equal(JSON.stringify(snapshot), frozen, 'Restore cannot rewrite the incoming evidence');
  mergeChatSnapshot(state, snapshot, 'qa-claude-client');
  assert.equal(Object.keys(state.runs).length, 1, 'Repeated restore does not duplicate the run');
});

test('question response evidence distinguishes multi indices from a single index or free text', () => {
  const run = { runId: 'r', conversationId: 'c' };
  const reply = { ...run, userInputId: INPUT.userInputId, action: 'submit', answers: [
    { questionId: 'q0', isSecret: false, optionIndices: [0, 2], labels: ['문서', '검증'] },
    { questionId: 'q1', isSecret: false, optionIndex: 1, label: '상세' },
  ] };
  assertClaudeAnswers(reply, run, INPUT);
  for (const mutate of [row => { row.runId = 'foreign'; }, row => { row.answers[0].optionIndices = [0]; },
    row => { row.answers[0].optionIndex = 0; }, row => { row.answers[0].text = '문서, 검증'; },
    row => { row.answers[1].optionIndex = 0; }, row => { row.action = 'skip'; }]) {
    const changed = clone(reply); mutate(changed); assert.throws(() => assertClaudeAnswers(changed, run, INPUT));
  }
});

const quietFixture = () => ({ observed: { sends: [], resumes: [], interrupts: [], approvals: [], userInputs: [],
  authWrites: [], blockedContexts: [], captures: [], contextRefusals: [] },
context: { captureBatches: 0, fileCaptureOperations: 0, inspectorReads: [], deliveries: [] }, runs: [] });

test('rate-limit proof binds the visible reset clock and percent to the same Claude run', () => {
  for (const [status, level, usedPercent] of [['allowed_warning', 'warn', 90], ['rejected', 'limit', 100]]) {
    const run = { runId: 'r', engineId: 'claude', rateLimit: { engineId: 'claude', status, resetsAt: NOW + 60000, autoResume: false, usedPercent } };
    const ui = { runs: [clone(run)], rates: [{ level, text: `Claude 사용량 ${usedPercent}% · 초기화 예정: 오후 9:01` }] };
    assertClaudeRateUi(run, ui, level, '오후 9:01');
    for (const mutate of [row => { row.rates[0].level = 'ok'; }, row => { row.rates[0].text = 'Claude 한도'; },
      row => { row.runs[0].rateLimit.resetsAt++; }, row => { row.runs[0].runId = 'foreign'; }]) {
      const changed = clone(ui); mutate(changed); assert.throws(() => assertClaudeRateUi(run, changed, level, '오후 9:01'));
    }
  }
  const before = quietFixture();
  assertNoAutomaticRequests(before, clone(before));
  for (const key of Object.keys(before.observed)) {
    const changed = clone(before); changed.observed[key].push({});
    assert.throws(() => assertNoAutomaticRequests(before, changed), key);
  }
  const captured = clone(before); captured.context.captureBatches++;
  assert.throws(() => assertNoAutomaticRequests(before, captured));
});

test('exact Context refusal must retain draft plus attachment, with no capture or send', () => {
  assert.equal(claudeContextSendErrorText('CLAUDE_CONTEXT_UNSUPPORTED'), CLAUDE_CONTEXT_ERROR, 'Coordinate changed product copy before freezing this proof');
  const before = { thread: { id: 'qa', engineId: 'claude', conversationId: null, draft: 'unsent draft',
    inputSources: [{ id: 'fixture', kind: 'file', sourceRef: { path: '/owned/qa-fixtures/fixture-reference.txt' } }] },
  composer: 'unsent draft', attachments: [{ id: 'fixture', text: 'QA fixture · 미전송' }] };
  const after = { ...clone(before), thread: { ...clone(before.thread), sendError: CLAUDE_CONTEXT_ERROR }, alerts: [CLAUDE_CONTEXT_ERROR] };
  const fixture = quietFixture();
  assertClaudeContextBlocked(before, after, fixture, clone(fixture));
  for (const mutate of [row => { row.composer = ''; }, row => { row.thread.draft = ''; }, row => { row.thread.inputSources = []; },
    row => { row.attachments = []; }, row => { row.thread.sendError = 'generic failure'; }, row => { row.alerts = []; },
    row => { row.thread.conversationId = 'started'; }]) {
    const changed = clone(after); mutate(changed); assert.throws(() => assertClaudeContextBlocked(before, changed, fixture, clone(fixture)));
  }
});

const contextThread = { id: 'qa', engineId: 'claude', engineProfileId: 'claude-default', wireClientThreadId: 'qa-wire' };
const contextRequest = () => ({ engineId: 'claude', engineProfileId: 'claude-default', clientThreadId: 'qa-wire',
  expectedContextScope: 'opaque-server-expectation-not-authority' });
const originalContext = 'V1 immutable original\nComplete final line';
const changedContext = 'V2 live original must not replace V1';
const sourceFile = '/owned/qa-fixtures/claude-context-test.txt';

function contextEvidence() {
  const captured = { sourceId: 'source-1', snapshotId: 'source-1', version: 1,
    hash: fingerprintQaBytes(originalContext).sha256, truncated: false, sourceRef: { path: sourceFile } };
  const run = { engineId: 'claude', clientThreadId: 'qa-wire', runId: 'run-1', conversationId: 'conversation-1',
    answerId: 'conversation-1/run-1', fixtureStage: 'context-bound',
    fixtureContextTools: ['egdesk_list_context', 'egdesk_read_source'], contextCaptures: [captured] };
  const request = { ...contextRequest(), attachments: [{ id: 'selected-1', kind: 'file', sourceRef: { path: sourceFile } }] };
  const before = quietFixture(), after = quietFixture();
  after.observed.captures.push({ request, captures: [captured] });
  after.observed.sends.push({ ...contextRequest(), runId: run.runId, contextSnapshotIds: [captured.sourceId],
    contextCapabilities: { read: true, reader: false, publishBriefing: false } });
  after.context.captureBatches = 1;
  after.context.fileCaptureOperations = 1;
  after.runs.push(run);
  const coverage = { sourceId: captured.sourceId, range: { startLine: 1, endLine: 2 }, totalLines: 2, complete: true, sourceTruncated: false };
  const text = JSON.stringify({ fixtureOnly: true, tool: 'egdesk_read_source', sourceId: captured.sourceId,
    snapshotId: captured.sourceId, sourceHash: captured.hash, version: 1, text: originalContext, coverage });
  const delivery = { sourceId: captured.sourceId, fixtureOnly: true, toolName: 'egdesk_read_source', packet: {
    role: 'agent_input', packetId: 'packet-1', mode: 'qa-fixture-claude-direct-read', deliveryStatus: 'sent-to-app-server',
    hash: fingerprintQaBytes(text).sha256, text, coverage, binding: { conversationId: run.conversationId, runId: run.runId, answerId: run.answerId } } };
  const inspector = { threadId: 'qa', articleCount: 1, sourceId: captured.sourceId, sourceText: originalContext, sourceVisible: true,
    sourceLabel: '원문 캡처 1–2 / 2행', sourceMetadata: `캡처 hash: ${captured.hash}`, packetId: delivery.packet.packetId,
    payloadText: text, payloadVisible: true };
  return { captured, run, before, after, delivery, inspector };
}

test('B2 proof requires exact UI engine/profile/thread routing, no owner grant and no browser/plan/computer tools', () => {
  assertClaudeContextRoute(contextRequest(), contextThread);
  for (const change of [{ engineId: 'codex' }, { engineProfileId: 'site-browser-profile' }, { clientThreadId: 'foreign' },
    { expectedContextScope: undefined }, { expectedContextScope: '' }, { expectedContextScope: 'x'.repeat(513) },
    { ownerKey: 'forged' }, { epoch: 1 }, { contextAuthority: {} }, { selectedSources: [] }, { browserToolSelection: {} },
    { executionPolicy: 'computer' }, { contextCapabilities: { read: true, reader: true, publishBriefing: false } },
    { contextCapabilities: { read: true, reader: false, publishBriefing: true } },
    { contextCapabilities: { read: true, reader: false, publishBriefing: false, plan: true } }]) {
    assert.throws(() => assertClaudeContextRoute({ ...contextRequest(), ...change }, contextThread));
  }
});

test('B2 capture proof rejects wrong source/version/hash/binding, refreshed expectation and capture-as-delivery claims', () => {
  const valid = contextEvidence();
  assert.deepEqual(assertClaudeContextCapture(valid.before, valid.after, contextThread, valid.run, sourceFile, originalContext), valid.captured);
  for (const mutate of [row => { row.after.observed.sends[0].expectedContextScope = 'silently-refreshed'; },
    row => { row.after.observed.captures[0].request.attachments[0].sourceRef.path = '/foreign/file'; },
    row => { row.captured.hash = fingerprintQaBytes(changedContext).sha256; }, row => { row.captured.version = 2; },
    row => { row.captured.truncated = true; }, row => { row.captured.snapshotId = 'another'; },
    row => { row.after.observed.sends[0].contextSnapshotIds = ['another']; }, row => { row.run.clientThreadId = 'foreign'; },
    row => { row.run.fixtureContextTools.push('egdesk_browser_interact'); },
    row => { row.after.context.deliveries.push({}); }, row => { row.after.context.captureBatches = 2; },
    row => { row.after.observed.sends.push(clone(row.after.observed.sends[0])); }]) {
    const changed = contextEvidence(); mutate(changed);
    assert.throws(() => assertClaudeContextCapture(changed.before, changed.after, contextThread, changed.run, sourceFile, originalContext));
  }
});

test('B2 immutable packet proof compares full original bytes, version, coverage, run and synthetic label', () => {
  const valid = contextEvidence();
  assertClaudeImmutablePacket(valid.delivery, valid.captured, valid.run, originalContext, changedContext);
  const alterPayload = (row, mutate) => {
    const payload = JSON.parse(row.delivery.packet.text); mutate(payload);
    row.delivery.packet.text = JSON.stringify(payload);
    row.delivery.packet.hash = fingerprintQaBytes(row.delivery.packet.text).sha256;
  };
  for (const mutate of [row => { row.delivery.fixtureOnly = false; }, row => { row.delivery.toolName = 'egdesk_browser_observe'; },
    row => { row.delivery.packet.binding.runId = 'foreign'; }, row => { row.delivery.packet.hash = 'forged'; },
    row => { row.delivery.packet.mode = 'native-reader'; }, row => { row.delivery.packet.coverage.complete = false; },
    row => alterPayload(row, value => { value.text = changedContext; }),
    row => alterPayload(row, value => { value.text = originalContext.split('\n')[0]; }),
    row => alterPayload(row, value => { value.version = 2; }),
    row => alterPayload(row, value => { value.sourceHash = 'forged'; }),
    row => alterPayload(row, value => { value.coverage.sourceTruncated = true; }),
    row => alterPayload(row, value => { value.fixtureOnly = false; })]) {
    const changed = contextEvidence(); mutate(changed);
    assert.throws(() => assertClaudeImmutablePacket(changed.delivery, changed.captured, changed.run, originalContext, changedContext));
  }
  assert.throws(() => assertClaudeImmutablePacket(valid.delivery, valid.captured, valid.run, originalContext, originalContext));
});

test('B2 inspector proof needs the exact visible source and separate exact visible synthetic packet in the same room', () => {
  const { inspector, captured, delivery } = contextEvidence();
  assertClaudeContextInspector(inspector, contextThread, captured, delivery, originalContext);
  for (const change of [{ threadId: 'foreign' }, { articleCount: 2 }, { sourceId: 'foreign' }, { sourceText: changedContext },
    { sourceVisible: false }, { sourceLabel: 'delivered' }, { sourceMetadata: 'missing hash' },
    { packetId: 'foreign' }, { payloadText: originalContext }, { payloadVisible: false }]) {
    assert.throws(() => assertClaudeContextInspector({ ...inspector, ...change }, contextThread, captured, delivery, originalContext));
  }
});

const readerDescriptor = ready => ({ contract: 'egdesk-context-b2', engineId: 'claude', engineProfileId: 'claude-default',
  selectedAttachments: true, immutableRead: true, expectedContextScope: 'server-expectation',
  nativeReader: ready, largeReader: ready, reader: { ready, engineId: 'claude', code: ready ? null : 'ENGINE_CAPACITY_UNKNOWN' },
  tools: ['egdesk_list_context', 'egdesk_read_source'] });

test('B3 readiness needs matched B2 scope plus verified largeReader/readiness, never an unconditional reader true', () => {
  assertClaudeReaderDescriptor(readerDescriptor(true), contextThread, true);
  assertClaudeReaderDescriptor(readerDescriptor(false), contextThread, false);
  for (const mutate of [row => { row.contract = 'b3-incompatible'; }, row => { row.nativeReader = false; },
    row => { delete row.largeReader; }, row => { row.largeReader = false; }, row => { row.reader.ready = false; },
    row => { row.reader.engineId = 'codex'; }, row => { row.reader.code = 'ENGINE_CAPACITY_UNKNOWN'; },
    row => { row.expectedContextScope = ''; }, row => { row.engineProfileId = 'site-profile'; },
    row => { row.tools.push('computer'); }]) {
    const changed = readerDescriptor(true); mutate(changed);
    assert.throws(() => assertClaudeReaderDescriptor(changed, contextThread, true));
  }
  assertClaudeContextRoute({ ...contextRequest(), contextCapabilities: { read: true, reader: true, publishBriefing: false } }, contextThread, { reader: true });
});

function readerEvidence(reviewed = 1) {
  const original = 'EXACT ORIGINAL SOURCE '.repeat(1200);
  const { captured, run, before, after, delivery } = contextEvidence();
  captured.hash = fingerprintQaBytes(original).sha256;
  const total = 2, sessionId = 'synthetic-reader-session';
  const coverage = { scope: 'capture', sourceId: captured.sourceId, complete: reviewed === total, sourceTruncated: false,
    reviewedPartitions: reviewed, totalPartitions: total, continuation: reviewed < total ? { readerSessionId: sessionId, nextPartition: reviewed } : null };
  const value = { fixtureOnly: true, synthetic: true, adapterExecutionVerified: false, tool: 'egdesk_read_source',
    sourceId: captured.sourceId, snapshotId: captured.sourceId, sourceHash: captured.hash, version: captured.version, mode: 'reader',
    summary: { text: `Synthetic QA Reader: ${reviewed}/${total} partitions processed; no model invoked.`,
      structure: [{ label: 'QA coverage only', text: 'Not a real model summary or whole-source quotation.' }] },
    selectedSpans: [{ startOffset: 0, endOffset: 80, quote: original.slice(0, 80) }], coverage,
    reader: { sessionId, revision: reviewed }, omissionPolicy: { type: 'reader-summary', fixtureOnly: true } };
  delivery.packet = { ...delivery.packet, mode: 'qa-fixture-claude-reader', text: JSON.stringify(value), coverage };
  delivery.packet.hash = fingerprintQaBytes(delivery.packet.text).sha256;
  return { original, captured, run, before, after, delivery, expected: { reviewed, total, sessionId } };
}

test('B3 partial Reader screenshots are unique for every bounded continuation step without overwriting evidence', () => {
  for (let total = 2; total <= 8; total++) {
    const labels = Array.from({ length: total - 1 }, (_, index) => claudeReaderPartialCaptureLabel(index + 1, total));
    assert.equal(new Set(labels).size, total - 1, 'Every partial iteration must retain its own screenshot');
    assert.ok(labels.every(label => /^[a-z0-9-]+$/.test(label)));
  }
  assert.deepEqual([1, 2].map(step => claudeReaderPartialCaptureLabel(step, 3)), [
    'claude-reader-partial-structured-summary-step-1-of-3',
    'claude-reader-partial-structured-summary-step-2-of-3',
  ]);
  for (const [step, total] of [[0, 3], [3, 3], [4, 3], [1, 1], [1.5, 3], [1, NaN]]) {
    assert.throws(() => claudeReaderPartialCaptureLabel(step, total));
  }
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-claude-fixture-flow.mjs', import.meta.url), 'utf8');
  assert.match(source, /await inspectHistory\(claudeReaderPartialCaptureLabel\(reviewed, total\),/);
  assert.doesNotMatch(source, /await inspectHistory\(['"]claude-reader-partial-structured-summary['"]/);
});

test('B3 summary proof rejects clipped/early complete coverage, lost quotes, fake native proof and changed live input', () => {
  for (const reviewed of [1, 2]) {
    const valid = readerEvidence(reviewed);
    assertClaudeReaderPacket(valid.delivery, valid.captured, valid.run, valid.original, valid.expected);
    for (const mutate of [value => { value.coverage.complete = !value.coverage.complete; },
      value => { value.coverage.sourceTruncated = true; }, value => { value.coverage.reviewedPartitions = 99; },
      value => { value.coverage.totalPartitions = 99; }, value => { value.coverage.continuation = {}; },
      value => { value.reader.sessionId = 'foreign'; }, value => { value.sourceHash = fingerprintQaBytes(changedContext).sha256; },
      value => { value.selectedSpans = []; }, value => { value.selectedSpans[0].quote = 'invented quotation'; },
      value => { value.selectedSpans[0].endOffset = 10; }, value => { value.summary.text = 'Complete summary'; },
      value => { value.summary.structure = []; }, value => { value.synthetic = false; },
      value => { value.adapterExecutionVerified = true; }, value => { value.nativeThreadId = 'fake-native'; }]) {
      const changed = readerEvidence(reviewed), value = JSON.parse(changed.delivery.packet.text);
      mutate(value);
      changed.delivery.packet.text = JSON.stringify(value);
      changed.delivery.packet.hash = fingerprintQaBytes(changed.delivery.packet.text).sha256;
      changed.delivery.packet.coverage = clone(value.coverage);
      assert.throws(() => assertClaudeReaderPacket(changed.delivery, changed.captured, changed.run, changed.original, changed.expected));
    }
  }
});

function processedEvidence() {
  const { original, captured, run } = readerEvidence();
  const before = quietFixture(), after = quietFixture();
  const text = JSON.stringify({ fixtureOnly: true, synthetic: true, sourceId: captured.sourceId, sourceHash: captured.hash,
    range: { startOffset: 0, endOffset: 12000 }, sourceText: original.slice(0, 12000) });
  after.context.readerProcessed = [{ sourceId: captured.sourceId, runId: run.runId, fixtureOnly: true,
    adapterExecutionVerified: false, inputPayload: { text, hash: fingerprintQaBytes(text).sha256 } }];
  after.observed.events = [{ event: 'reader.completed', runId: run.runId, details: { deliveryStatus: 'prepared', coverage: { complete: false } } }];
  return { before, after, original, captured, run };
}

test('B3 processed proof hashes exact contiguous assigned input and never treats processing as Main receipt', () => {
  const valid = processedEvidence();
  assertClaudeReaderProcessed(valid.before, valid.after, valid.run, valid.captured, valid.original, 1);
  for (const mutate of [row => { row.after.context.deliveries.push({}); },
    row => { row.after.context.readerProcessed[0].inputPayload.hash = 'forged'; },
    row => { row.after.context.readerProcessed[0].adapterExecutionVerified = true; },
    row => { row.after.observed.events[0].details.coverage.complete = true; },
    row => { row.after.observed.events[0].details.deliveryStatus = 'sent-to-app-server'; },
    row => {
      const receipt = row.after.context.readerProcessed[0].inputPayload;
      const input = JSON.parse(receipt.text); input.sourceText = changedContext;
      receipt.text = JSON.stringify(input); receipt.hash = fingerprintQaBytes(receipt.text).sha256;
    }]) {
    const changed = processedEvidence(); mutate(changed);
    assert.throws(() => assertClaudeReaderProcessed(changed.before, changed.after, changed.run, changed.captured, changed.original, 1));
  }
});

test('B3 failure/cancel proof retains accepted source but refuses false completion, delivery and fallback', () => {
  for (const status of ['failed', 'interrupted']) {
    const { run, captured } = readerEvidence();
    const before = { ...quietFixture(), providerTurns: 0 };
    before.runs.push({ ...run, messages: [] });
    const after = clone(before); after.runs[0].status = status;
    after.observed.events = [{ event: 'run.completed', runId: run.runId, details: { status } }];
    assertClaudeReaderEnded(before, after, run, captured, status);
    for (const mutate of [row => { row.runs[0].status = 'completed'; }, row => { row.runs[0].contextCaptures = []; },
      row => { row.runs[0].messages.push({ role: 'assistant' }); }, row => { row.observed.sends.push({ engineId: 'codex' }); },
      row => { row.observed.resumes.push({}); }, row => { row.observed.captures.push({}); }, row => { row.context.deliveries.push({}); },
      row => { row.observed.events.push({ event: 'context.read.completed', runId: run.runId }); }, row => { row.providerTurns = 1; }]) {
      const changed = clone(after); mutate(changed);
      assert.throws(() => assertClaudeReaderEnded(before, changed, run, captured, status));
    }
  }
});

test('B3 capacity error uses the current actionable copy and retains unsent draft/source without a guessed read', () => {
  const message = claudeContextSendErrorText('ENGINE_CAPACITY_UNKNOWN');
  assert.ok(message.includes('용량') && message.includes('초안') && message.includes('전송하지'));
  const before = { thread: { ...contextThread, draft: 'capacity draft', conversationId: null,
    inputSources: [{ sourceRef: { path: sourceFile } }] }, composer: 'capacity draft', attachments: [{ id: 'large' }] };
  const after = { ...clone(before), thread: { ...clone(before.thread), sendError: message }, alerts: [message] };
  const start = quietFixture(), end = quietFixture();
  end.context.captureBatches = end.context.fileCaptureOperations = 1;
  end.observed.captures.push({ request: { ...contextRequest(), attachments: [{ sourceRef: { path: sourceFile } }] } });
  end.observed.contextRefusals.push({ route: '/chat/send', code: 'ENGINE_CAPACITY_UNKNOWN' });
  assertClaudeReaderBlocked(before, after, start, end, { message, code: 'ENGINE_CAPACITY_UNKNOWN' });
});

function attachmentHarness(rows = [
  { viewId: 'small', checked: false, type: 'checkbox', disabled: false },
  { viewId: 'large', checked: true, type: 'checkbox', disabled: false },
], { updateCheckbox = true } = {}) {
  const choices = clone(rows), clicks = [], panel = '#egd-codex-input-panel[data-thread-id="qa"]';
  return { clicks, choices, panel,
    async inspect(selector) {
      if (selector === panel) return [{ visible: true }];
      const match = selector.match(/\[data-view-id="([^"]+)"\]/);
      assert.ok(selector.startsWith(`${panel} `) && match);
      return choices.filter(row => row.viewId === match[1]).map(() => ({ visible: true }));
    },
    async evaluateChrome() { return clone(choices); },
    async click(selector) {
      clicks.push(selector);
      if (selector === '[data-testid="chat-attach-open"]' || selector === `${panel} [data-testid="chat-attach-confirm"]`) return;
      assert.ok(selector.startsWith(`${panel} [data-testid="chat-attach-source"]`));
      const id = selector.match(/\[data-view-id="([^"]+)"\]/)[1];
      const target = choices.filter(row => row.viewId === id);
      assert.equal(target.length, 1);
      if (updateCheckbox) target[0].checked = !target[0].checked;
    },
  };
}

test('B2 attachment selection uses the current-room actual checkbox and confirm clicks, never draft injection', async () => {
  const harness = attachmentHarness();
  await selectClaudeAttachment(harness, 'qa', 'small', ['small', 'large']);
  assert.deepEqual(harness.clicks, ['[data-testid="chat-attach-open"]',
    `${harness.panel} [data-testid="chat-attach-source"][data-view-id="small"]`,
    `${harness.panel} [data-testid="chat-attach-source"][data-view-id="large"]`,
    `${harness.panel} [data-testid="chat-attach-confirm"]`]);
  assert.deepEqual(harness.choices.filter(row => row.checked).map(row => row.viewId), ['small']);
});

test('B2 selection refuses ambiguous/missing/non-checkbox/foreign selection and unobserved checkbox changes', async () => {
  const normal = attachmentHarness().choices;
  for (const rows of [[normal[0], normal[0]], [normal[1]], [{ ...normal[0], type: 'radio' }],
    [{ ...normal[0], disabled: true }], [normal[0], { ...normal[1], viewId: 'unowned' }]]) {
    const harness = attachmentHarness(rows);
    await assert.rejects(selectClaudeAttachment(harness, 'qa', 'small', ['small', 'large']));
    assert.deepEqual(harness.clicks, ['[data-testid="chat-attach-open"]']);
  }
  const unchanged = attachmentHarness(normal, { updateCheckbox: false });
  await assert.rejects(selectClaudeAttachment(unchanged, 'qa', 'small', ['small', 'large']));
  assert.ok(unchanged.clicks.every(selector => !selector.includes('chat-attach-confirm')));
});

test('large-source refusal keeps draft+attachment and permits only one capture, never accepted send/delivery or silent retry', () => {
  assert.equal(claudeContextSendErrorText('CLAUDE_CONTEXT_READER_UNSUPPORTED'), CLAUDE_READER_ERROR);
  const before = { thread: { ...contextThread, conversationId: null, draft: 'unsent large draft',
    inputSources: [{ id: 'large', kind: 'file', sourceRef: { path: sourceFile } }] }, composer: 'unsent large draft',
  attachments: [{ id: 'large', text: 'large source · 미전송' }] };
  const after = { ...clone(before), thread: { ...clone(before.thread), sendError: CLAUDE_READER_ERROR }, alerts: [CLAUDE_READER_ERROR] };
  const start = quietFixture(), end = quietFixture();
  end.context.captureBatches = 1;
  end.context.fileCaptureOperations = 1;
  end.observed.captures.push({ request: { ...contextRequest(), attachments: [{ sourceRef: { path: sourceFile } }] } });
  end.observed.contextRefusals.push({ route: '/chat/send', code: 'CLAUDE_CONTEXT_READER_UNSUPPORTED' });
  assertClaudeReaderBlocked(before, after, start, end);
  for (const mutate of [row => { row.ui.composer = ''; }, row => { row.ui.thread.draft = ''; },
    row => { row.ui.thread.inputSources = []; }, row => { row.ui.attachments = []; }, row => { row.ui.alerts = []; },
    row => { row.ui.thread.sendError = CLAUDE_CONTEXT_ERROR; }, row => { row.fixture.context.captureBatches++; },
    row => { row.fixture.observed.sends.push({ engineId: 'codex' }); }, row => { row.fixture.runs.push({}); },
    row => { row.fixture.context.deliveries.push({}); }, row => { row.fixture.observed.contextRefusals.push({}); },
    row => { row.fixture.observed.captures[0].request.attachments[0].sourceRef.path = '/foreign'; }]) {
    const changed = { ui: clone(after), fixture: clone(end) }; mutate(changed);
    assert.throws(() => assertClaudeReaderBlocked(before, changed.ui, start, changed.fixture));
  }
});

const readyViewport = () => ({ shellCount: 1, shell: anchorBox(500, 100, 400, 600), dock: anchorBox(300, 750, 600, 40),
  view: { width: 1200, height: 800 }, navigation: [{ rect: anchorBox(520, 140, 30, 30), disabled: false, hittable: true }],
  camera: { pan: { x: 0, y: 0 }, panTarget: { x: 0, y: 0 }, zoom: 0.96, zoomTarget: 0.96 } });

test('Claude fixture navigation requires settled camera, whole visible Chat and one unobscured native navigation control', () => {
  assert.equal(claudeFixtureChatNavigable(readyViewport()), true);
  for (const mutate of [row => { row.camera.panTarget.y = -500; }, row => { row.camera.zoomTarget = 0.8; },
    row => { row.camera.pan.x = NaN; }, row => { row.camera.zoom = 0; }, row => { row.shell.top = -300; },
    row => { row.shell.bottom = 820; }, row => { row.dock = anchorBox(600, 600, 500, 50); },
    row => { row.shellCount = 2; }, row => { row.navigation = []; }, row => { row.navigation.push(clone(row.navigation[0])); },
    row => { row.navigation[0].hittable = false; }, row => { row.navigation[0].disabled = true; },
    row => { row.navigation[0].rect.top = -10; }]) {
    const changed = readyViewport(); mutate(changed); assert.equal(claudeFixtureChatNavigable(changed), false);
  }
  assert.equal(claudeFixtureCameraSettled({}), false);
});

test('Claude setup waits through pending file-card pan before one native Dock return and then stable hit-tested navigation', async () => {
  const ready = readyViewport(), moving = readyViewport(), offscreen = readyViewport(), returning = readyViewport(), covered = readyViewport();
  moving.camera.panTarget.y = -500; // Current Chat rect still looks usable before the first camera frame.
  offscreen.shell.top = -400; offscreen.shell.bottom = 200;
  offscreen.navigation[0].rect.top = -360; offscreen.navigation[0].hittable = false;
  offscreen.camera.pan.y = offscreen.camera.panTarget.y = -500;
  returning.camera.pan.y = -20;
  covered.navigation[0].hittable = false;
  const before = [moving, moving, offscreen, offscreen], after = [returning, covered, ready, ready];
  let returningHome = false, beforeReads = 0, afterReads = 0;
  const clicks = [];
  const harness = {
    async evaluateChrome(script) {
      if (!script.includes('shellCount: shells.length')) return clone(returningHome ? returning : offscreen); // Existing openChat's read-only observer.
      return clone(returningHome ? after[Math.min(afterReads++, after.length - 1)] : before[Math.min(beforeReads++, before.length - 1)]);
    },
    async click(selector) {
      assert.equal(beforeReads, 4, 'Do not return while the file-card camera target is still moving');
      assert.equal(selector, '.egd-dock-btn[data-id="chat"]');
      assert.equal(returningHome, false, 'No blind click retry');
      clicks.push(selector); returningHome = true;
    },
  };
  const result = await returnClaudeChatAfterFixtureSetup(harness);
  assert.deepEqual(clicks, ['.egd-dock-btn[data-id="chat"]']);
  assert.equal(result.before.camera.panTarget.y, -500);
  assert.equal(result.settled.shell.top, -400);
  assert.deepEqual(result.returned, ready);
  assert.equal(afterReads, 4, 'Do not navigate until movement and occlusion are both gone for two samples');
});

test('Claude setup already in view uses observations only and does not click Dock or create a room', async () => {
  const harness = { async evaluateChrome() { return readyViewport(); }, async click() { assert.fail('Already usable Chat needs no action'); } };
  assert.deepEqual((await returnClaudeChatAfterFixtureSetup(harness)).returned, readyViewport());
});

test('verifier imports have no runtime and observations do not synthesize UI actions or replace transport', () => {
  assert.doesNotMatch(observeClaudeUi.toString(), /\.click\(|dispatchEvent|\.checked\s*=|\.value\s*=/);
  for (const observer of [observeAttachmentChoices, observeClaudeContextInspector, observeClaudeFixtureViewport]) {
    assert.doesNotMatch(observer.toString(), /\.click\(|dispatchEvent|\.checked\s*=|\.value\s*=|\.panTarget\s*=|\.zoomTarget\s*=/);
  }
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-claude-fixture-flow.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:loopbackJson|fetch)\(['"]\/(?:chat\/(?:send|approval|user-input)|auth\/)/);
  assert.doesNotMatch(source, /(?:window\.fetch|window\.EventSource)\s*=/);
  assert.doesNotMatch(source, /codexBridge\.(?:addInputSources|send|previewInputs)|:39218/);
  assert.match(source, /await selectClaudeAttachment\(harness, thread.id/);
  assert.match(source, /await sendFromComposer\(harness, prompt\)/);
  assert.match(source, /await selectQaThread\(harness, ordinary\)/);
  assert.match(source, /adapterExecutionVerified = false/);
  assert.match(source, /validateQaFixtureIsolation\(options.profile\)/);
  assert.match(source, /path.resolve\(process.argv\[1\]\) === fileURLToPath\(import.meta.url\)/);
});
