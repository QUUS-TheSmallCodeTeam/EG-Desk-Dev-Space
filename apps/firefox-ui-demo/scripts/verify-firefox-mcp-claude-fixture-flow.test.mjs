import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { claudeFixtureOptions, assertClaudeFixturePeer, assertClaudeReady, assertSessionOffer,
  assertClaudeQuestionUi, selectClaudeQuestionAnswers, assertClaudeAnswers, assertNoAutomaticRequests,
  assertClaudeContextBlocked, assertClaudeRateUi, CLAUDE_CONTEXT_ERROR, observeClaudeUi,
  selectClaudeInOpenEnginePicker, observeEnginePickerAnchor, assertEnginePickerAnchor } from './verify-firefox-mcp-claude-fixture-flow.mjs';
import { claudeFixtureEngines, CLAUDE_FIXTURE_QUESTIONS } from './egdesk-chat-fixture-transport.mjs';
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
  authWrites: [], blockedContexts: [] }, context: { captureBatches: 0, fileCaptureOperations: 0, inspectorReads: [], deliveries: [] }, runs: [] });

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

test('verifier imports have no runtime and observations do not synthesize UI actions or replace transport', () => {
  assert.doesNotMatch(observeClaudeUi.toString(), /\.click\(|dispatchEvent|\.checked\s*=|\.value\s*=/);
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-claude-fixture-flow.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:loopbackJson|fetch)\(['"]\/(?:chat\/(?:send|approval|user-input)|auth\/)/);
  assert.doesNotMatch(source, /(?:window\.fetch|window\.EventSource)\s*=/);
  assert.match(source, /await sendFromComposer\(harness, prompt\)/);
  assert.match(source, /await selectQaThread\(harness, ordinary\)/);
  assert.match(source, /adapterExecutionVerified = false/);
  assert.match(source, /validateQaFixtureIsolation\(options.profile\)/);
  assert.match(source, /path.resolve\(process.argv\[1\]\) === fileURLToPath\(import.meta.url\)/);
});
