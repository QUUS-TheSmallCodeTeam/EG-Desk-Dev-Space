#!/usr/bin/env node
// Main-owned, model-free UI proof. Importing this module starts nothing.
// Actions use the profile-bound MCP harness. Chrome evaluation only observes,
// except the three named fixture setup operations below. Never calls an adapter.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qaBridgeConfig, validateQaFixtureIsolation } from './egdesk-qa-fixture-isolation.mjs';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { CLAUDE_FIXTURE_TEXT, CLAUDE_FIXTURE_QUESTIONS } from './egdesk-chat-fixture-transport.mjs';
import { runUiFlow, chrome, loopbackJson, newQaThread, selectQaThread, sendFromComposer,
  replaceComposerText, visible, waitUntil } from './egdesk-qa-ui-flow.mjs';

export const CLAUDE_CONTEXT_ERROR = '현재 Claude 연결에서는 선택한 자료를 사용할 수 없어 보내지 않았습니다. 자료를 제외한 뒤 다시 보내세요.';
const PANEL = '#egd-codex-activity-panel';
const ENGINE_PICKER = '[data-testid="chat-engine-panel"][role="dialog"][aria-label="AI 엔진 설정"]';
const inputCard = id => `${PANEL} [data-testid="chat-user-input"][data-user-input-id=${JSON.stringify(id)}]`;
const approvalCard = id => `${PANEL} [data-testid="chat-approval"][data-approval-id=${JSON.stringify(id)}]`;

export function claudeFixtureOptions(argv, env = process.env, now = Date.now()) {
  const options = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    assert.ok(['--profile', '--deadline-utc'].includes(key) && value && !value.startsWith('--') && !options.has(key),
      'Expected --profile PATH and optional --deadline-utc UTC_ISO_TIMESTAMP');
    options.set(key, value);
  }
  const profile = options.get('--profile');
  assert.ok(profile && path.isAbsolute(profile), 'An explicit absolute QA --profile is required');
  const bridge = qaBridgeConfig(env);
  assert.ok(bridge.fixture && env.EGDESK_QA_CLAUDE_FIXTURE === '1', 'Explicit isolated Claude fixture mode required');
  assert.ok(env.EGDESK_QA_REAL_TURN == null || env.EGDESK_QA_REAL_TURN === '0', 'Real-provider mode is forbidden');
  assert.equal(env.MOZ_HEADLESS, '1', 'Claude fixture UI proof is headless-only');
  assert.equal(String(env.EGDESK_MARIONETTE_PORT || '2829'), '2829', 'Only Main-owned QA Marionette 2829 is allowed');
  assert.ok(![2828, 2829, 6000, 6001].includes(bridge.port), 'Fixture must not share an automation port');
  assert.ok(typeof env.EGDESK_QA_FIXTURE_TOKEN === 'string' && env.EGDESK_QA_FIXTURE_TOKEN.length >= 16, 'Fixture control token required');
  const utc = options.get('--deadline-utc');
  if (utc) assert.match(utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/, 'Deadline must be an explicit UTC ISO timestamp');
  const deadlineMs = utc ? Date.parse(utc) : now + 6 * 60_000;
  assert.ok(Number.isFinite(deadlineMs) && deadlineMs > now && deadlineMs - now <= 15 * 60_000,
    'Deadline must be in the future and within 15 minutes');
  return { profile, bridge, deadlineMs };
}

export function assertClaudeFixturePeer(peer, { profile, bridge }) {
  assert.equal(peer.fixture, true);
  assert.equal(peer.claudeFixture, true, 'Start the separate Claude fixture, not the Chat72 fixture');
  assert.equal(peer.profile, profile, 'Fixture must belong to the exact QA profile');
  assert.equal(peer.host, bridge.host);
  assert.equal(peer.port, bridge.port);
  assert.equal(peer.origin, bridge.origin);
  assert.equal(peer.providerTurns, 0);
}

export function assertClaudeReady(state) {
  assert.equal(state.appServerReady, false, 'Codex must remain offline');
  assert.equal(state.auth?.isLoggedIn, false, 'Codex auth must remain false');
  assert.equal(state.engines?.find(row => row.id === 'codex')?.status, 'offline');
  const claude = state.engines?.find(row => row.id === 'claude');
  assert.equal(claude?.status, 'ready');
  const active = claude.profiles.filter(profile => profile.active);
  assert.equal(active.length, 1);
  assert.equal(active[0].auth.status, 'signedIn');
}

export function assertSessionOffer(approval, offer, offered) {
  assert.equal(approval.kind, 'commandExecution');
  assert.equal(approval.status, 'pending');
  assert.equal(offer.synthetic, true);
  assert.equal(offer.adapterExecutionVerified, false);
  assert.deepEqual(offer.choices, approval.choices);
  assert.equal(approval.choices.includes('acceptForSession'), offered);
  if (!offered) return assert.equal(offer.sessionRule, null);
  assert.deepEqual(offer.sessionRule, { type: 'addRules', behavior: 'allow', destination: 'session',
    rules: [{ toolName: 'Bash', ruleContent: approval.command }] });
  assert.equal(approval.command, "printf 'QA Claude fixture only'");
}

export function assertClaudeQuestionUi(input, card) {
  assert.deepEqual(input.questions, CLAUDE_FIXTURE_QUESTIONS);
  assert.equal(card?.id, input.userInputId);
  assert.equal(card.status, 'pending');
  for (const question of input.questions) {
    assert.ok(card.text.includes(question.header) && card.text.includes(question.question));
    const options = card.options.filter(option => option.questionId === question.questionId && option.optionIndex !== 'other');
    assert.equal(options.length, question.options.length);
    for (const [index, option] of options.entries()) {
      assert.equal(option.optionIndex, String(index));
      assert.equal(option.type, question.multiSelect ? 'checkbox' : 'radio');
      assert.equal(option.disabled, false);
      assert.ok(card.text.includes(question.options[index].label) && card.text.includes(question.options[index].description));
    }
  }
}

// Screen-space observations only: Canvas transforms must not be mistaken for
// viewport coordinates. Do not move, scroll or restyle the product to pass.
export const observeEnginePickerAnchor = harness => chrome(harness, selector => {
  const codex = window.__egdesk.state.codex;
  const panels = [...document.querySelectorAll(selector)];
  const chips = [...document.querySelectorAll('[data-testid="chat-engine-chip"][aria-expanded="true"]')];
  const panel = panels.length === 1 ? panels[0] : null;
  const chip = chips.length === 1 ? chips[0] : null;
  const card = chip?.closest('.egd-codex-chat-shell') || null;
  const box = node => {
    if (!node) return null;
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height,
      visible: node.isConnected && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 };
  };
  return { activeThreadId: codex.activeThreadId, pickerThreadId: codex.engineMenu?.threadId || null,
    panelCount: panels.length, expandedChipCount: chips.length,
    sameCard: !!card && panel?.closest('.egd-codex-chat-shell') === card,
    panel: box(panel), chip: box(chip), card: box(card),
    viewport: { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
      width: window.innerWidth, height: window.innerHeight } };
}, ENGINE_PICKER);

export function assertEnginePickerAnchor(observed, threadId) {
  assert.equal(observed.activeThreadId, threadId, 'Engine chip must belong to the QA thread');
  assert.equal(observed.pickerThreadId, threadId, 'Open engine picker must belong to the QA thread');
  assert.equal(observed.panelCount, 1, 'Expected exactly one engine picker');
  assert.equal(observed.expandedChipCount, 1, 'Expected exactly one expanded engine chip');
  assert.equal(observed.sameCard, true, 'Engine picker and expanded chip must share the same Chat card');
  const { panel, chip, card, viewport } = observed;
  for (const [label, rect] of Object.entries({ panel, chip, card, viewport })) {
    assert.ok(rect && ['left', 'top', 'right', 'bottom', 'width', 'height'].every(key => Number.isFinite(rect[key]))
      && rect.width > 0 && rect.height > 0 && rect.right > rect.left && rect.bottom > rect.top, `Invalid ${label} geometry`);
    if (label !== 'viewport') assert.equal(rect.visible, true, `${label} must be visible`);
  }
  // Dimension-relative rounding tolerance and gap: no fixed screen positions,
  // menu size or zoom assumption. Allow above/below and viewport-edge clamping.
  const tolerance = Math.min(chip.width, chip.height) / 20;
  const contains = (outer, inner) => inner.left >= outer.left - tolerance && inner.right <= outer.right + tolerance
    && inner.top >= outer.top - tolerance && inner.bottom <= outer.bottom + tolerance;
  assert.ok(contains(viewport, panel) && contains(viewport, chip), 'Engine picker and chip must fit the visible viewport');
  assert.ok(contains(card, chip), 'Expanded engine chip must be inside its own Chat card');
  const horizontalOverlap = Math.max(0, Math.min(panel.right, chip.right) - Math.max(panel.left, chip.left));
  const overlapRatio = horizontalOverlap / Math.min(panel.width, chip.width);
  assert.ok(overlapRatio >= 0.5, 'Engine picker must horizontally overlap its own chip');
  const belowGap = panel.top - chip.bottom, aboveGap = chip.top - panel.bottom;
  const gap = Math.max(belowGap, aboveGap);
  assert.ok(gap >= -tolerance && gap <= chip.height, 'Engine picker must sit just above or below its chip, not cover or drift away from it');
  return { placement: belowGap >= aboveGap ? 'below' : 'above', gap, maxGap: chip.height, overlapRatio };
}

export async function selectClaudeInOpenEnginePicker(harness, threadId, captureOpened = async () => {}) {
  assert.ok(threadId, 'Expected the newly created QA thread');
  const panels = await visible(harness, ENGINE_PICKER);
  assert.equal(panels.length, 1, 'Expected exactly one open engine picker');
  const observed = await observeEnginePickerAnchor(harness);
  // Save the opened panel even when its anchor is wrong; capture is not a
  // visual-pass claim. No selection happens before this geometric assertion.
  await captureOpened(observed);
  assertEnginePickerAnchor(observed, threadId);
  // Empty-chat choices share this test ID. Only the actually opened dialog
  // owns this action; never choose a document-wide first match or nth item.
  const selector = `${ENGINE_PICKER} [data-testid="chat-engine-choice"][data-engine="claude"]`;
  const choices = await harness.inspect(selector);
  assert.equal(choices.length, 1, 'Expected exactly one Claude choice inside the open picker');
  assert.ok(choices[0].visible && !choices[0].disabled, 'Open picker Claude choice must be visible and enabled');
  await harness.click(selector);
}

export async function selectClaudeQuestionAnswers(harness, input) {
  assert.deepEqual(input.questions, CLAUDE_FIXTURE_QUESTIONS);
  for (const [questionId, optionIndex] of [['q0', 0], ['q0', 2], ['q1', 1]]) {
    await harness.click(`${inputCard(input.userInputId)} [data-testid="chat-user-input-option"][data-question-id="${questionId}"][data-option-index="${optionIndex}"]`);
  }
}

export function assertClaudeAnswers(reply, run, input) {
  assert.equal(reply.runId, run.runId);
  assert.equal(reply.conversationId, run.conversationId);
  assert.equal(reply.userInputId, input.userInputId);
  assert.equal(reply.action, 'submit');
  assert.deepEqual(reply.answers, [
    { questionId: 'q0', isSecret: false, optionIndices: [0, 2], labels: ['문서', '검증'] },
    { questionId: 'q1', isSecret: false, optionIndex: 1, label: '상세' },
  ]);
}

export function assertNoAutomaticRequests(before, after) {
  for (const key of ['sends', 'resumes', 'interrupts', 'approvals', 'userInputs', 'authWrites', 'blockedContexts']) {
    assert.deepEqual(after.observed[key], before.observed[key], `Unexpected automatic ${key}`);
  }
  assert.deepEqual(after.context, before.context, 'No context capture/read/delivery is allowed');
  assert.equal(after.runs.length, before.runs.length);
}

export function assertClaudeRateUi(run, ui, level, clock) {
  assert.equal(run.engineId, 'claude');
  assert.equal(run.rateLimit.autoResume, false);
  assert.equal(run.rateLimit.status, level === 'warn' ? 'allowed_warning' : 'rejected');
  assert.deepEqual(ui.runs.find(row => row.runId === run.runId)?.rateLimit, run.rateLimit);
  assert.ok(clock && ui.rates.some(row => row.level === level && row.text.includes('Claude')
    && row.text.includes(`${run.rateLimit.usedPercent}%`) && row.text.includes('초기화') && row.text.includes(clock)));
}

export function assertClaudeContextBlocked(before, after, beforeFixture, afterFixture) {
  assert.equal(after.thread.id, before.thread.id);
  assert.equal(after.thread.engineId, 'claude');
  assert.equal(after.thread.sendError, CLAUDE_CONTEXT_ERROR);
  assert.ok(after.alerts.includes(CLAUDE_CONTEXT_ERROR), 'Exact Context error must be visible');
  assert.ok(before.composer && before.thread.inputSources.length === 1, 'A draft and one selected fixture are required');
  assert.equal(after.composer, before.composer);
  assert.equal(after.thread.draft, before.thread.draft);
  assert.equal(after.thread.draft, after.composer);
  assert.deepEqual(after.thread.inputSources, before.thread.inputSources);
  assert.deepEqual(after.attachments, before.attachments);
  assert.equal(after.attachments.length, 1);
  assert.equal(after.thread.conversationId, null);
  assertNoAutomaticRequests(beforeFixture, afterFixture);
}

// Read-only observations. No actions, event injection, setter calls or DOM edits.
export const observeClaudeUi = harness => chrome(harness, () => {
  const api = window.__egdesk, codex = api.state.codex;
  const thread = codex.threads.find(item => item.id === codex.activeThreadId);
  const ChatState = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
  const shown = node => {
    const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const nodes = selector => [...document.querySelectorAll(selector)].filter(shown);
  return {
    codexLoggedIn: codex.authStatus?.isLoggedIn,
    thread: thread && { id: thread.id, title: thread.title, engineId: ChatState.chatThreadEngineId(thread, codex),
      wireClientThreadId: ChatState.clientThreadBinding(thread), conversationId: thread.conversationId || null,
      profileEnabled: thread.profileEnabled, sendError: thread.sendError || null, resuming: !!thread.resuming,
      bindingHeld: ChatState.nativeBindingHeld(thread), draft: codex.threadDrafts[thread.id] || '', inputSources: thread.inputSources || [] },
    chips: nodes('[data-testid="chat-engine-chip"]').map(node => ({ engineId: node.dataset.engine, text: node.textContent })),
    composer: document.querySelector('.egd-codex-input')?.value ?? null,
    runs: api.codexBridge.runState(thread?.id),
    messages: nodes('[data-testid="chat-message"]').map(node => ({ role: node.dataset.role, runId: node.dataset.runId,
      text: node.querySelector('.egd-codex-bubble-content')?.textContent || '', author: node.querySelector('.egd-codex-message-role')?.textContent || '' })),
    questions: nodes('#egd-codex-activity-panel [data-testid="chat-user-input"]').map(node => ({ id: node.dataset.userInputId,
      status: node.dataset.status, text: node.textContent, options: [...node.querySelectorAll('[data-testid="chat-user-input-option"]')].map(control => ({
        questionId: control.dataset.questionId, optionIndex: control.dataset.optionIndex, type: control.type, checked: control.checked, disabled: control.disabled })) })),
    rates: nodes('[data-testid="chat-run-rate-limit"]').map(node => ({ level: node.dataset.level, text: node.textContent })),
    alerts: nodes('.egd-codex-error[role="alert"]').map(node => node.textContent),
    attachments: nodes('[data-testid="chat-attachment"]').map(node => ({ id: node.dataset.sourceId, text: node.textContent })),
  };
});

async function openActivity(harness) {
  if (!(await harness.inspect(PANEL)).some(node => node.visible)) await harness.click('[data-testid="chat-activity-open"]');
  await visible(harness, PANEL);
}

async function closeActivity(harness) {
  if ((await harness.inspect(PANEL)).some(node => node.visible)) await harness.click(`${PANEL} button[aria-label="활동 기록 닫기"]`);
}

export async function runClaudeFixtureFlow(options) {
  // Before connecting, validate the exact owned profile, manifest, original and
  // transformed hashes. The shared harness repeats this gate independently.
  validateQaFixtureIsolation(options.profile);
  const manifest = assertQaFixtureManifest(options.profile);
  const token = process.env.EGDESK_QA_FIXTURE_TOKEN;
  const deadline = () => assert.ok(Date.now() < options.deadlineMs, 'Claude fixture UTC deadline reached');
  const readFixture = async () => {
    deadline();
    const state = await loopbackJson('/__qa/state', { token });
    assertClaudeFixturePeer(state, options);
    return state;
  };
  const control = async (runId, phase) => {
    await readFixture();
    return loopbackJson('/__qa/release', { method: 'POST', token, body: { runId, phase } });
  };
  const health = await loopbackJson('/health');
  assertClaudeFixturePeer(health, options);
  assertClaudeReady(await loopbackJson('/v1/state'));
  const initial = await readFixture();
  assert.equal(initial.observed.sends.length, 0, 'Claude proof requires a fresh separate fixture');
  assert.equal(initial.runs.length, 0);
  assert.equal(initial.observed.authWrites.length, 0);

  await runUiFlow('claude-model-free-ui-fixture', async ({ harness, result, check, capture }) => {
    result.providerTurn = 'fixture-only';
    result.qaOnly = true;
    result.adapterExecutionVerified = false;
    result.osExecutionVerified = false;
    result.deadlineUtc = new Date(options.deadlineMs).toISOString();
    result.scope = 'Visible Claude UI with Codex offline; not provider execution, permission persistence, full restart or backend adapter proof';
    result.fixtureSetup = ['owned headless viewport', 'new-room QA title metadata', 'one manifest-owned draft attachment'];
    // Strict fixture setup 1: only resize the actual owned headless window.
    check('actual Firefox is headless browser chrome', await chrome(harness, () => {
      const gfx = Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo);
      if (gfx.isHeadless !== true || document.documentURI !== 'chrome://browser/content/browser.xhtml') return false;
      window.resizeTo(1440 + window.outerWidth - window.innerWidth, 900 + window.outerHeight - window.innerHeight);
      return true;
    }));
    if (!(await harness.inspect('#egd-dock .egd-dock-btn[data-id="chat"]')).some(node => node.visible)) {
      await harness.press(process.platform === 'darwin' ? 'meta+-' : 'Control+-');
      await visible(harness, '#egd-dock .egd-dock-btn[data-id="chat"]');
    }
    const waitUi = (predicate, label) => waitUntil(async () => { deadline(); return observeClaudeUi(harness); }, predicate,
      { timeoutMs: Math.max(1, Math.min(15000, options.deadlineMs - Date.now())), intervalMs: 100 })
      .catch(error => { throw new Error(`${label}: ${error.message}`); });
    const nonce = Date.now().toString(36);
    const newClaude = async label => {
      deadline();
      await closeActivity(harness);
      // Strict fixture setup 2: existing helper sets title metadata only;
      // creation, engine selection and all sends remain actual MCP actions.
      const thread = await newQaThread(harness, `QA Claude ${label} ${nonce}`);
      if (!(await observeClaudeUi(harness)).chips.some(chip => chip.engineId === 'claude')) {
        await harness.click('[data-testid="chat-engine-chip"]');
        await selectClaudeInOpenEnginePicker(harness, thread.id, async observed => {
          (result.enginePickerGeometry ||= []).push({ label, ...observed });
          await capture(`claude-engine-picker-open-${label}`);
          const geometry = assertEnginePickerAnchor(observed, thread.id);
          check('opened engine picker is viewport-visible and anchored to its own chip/card', true, geometry);
        });
      }
      if ((await harness.inspect('[data-testid="chat-engine-panel"]')).some(node => node.visible)) await harness.click('[data-testid="chat-engine-chip"]');
      const ui = await waitUi(ui => ui.thread?.engineId === 'claude' && ui.chips.some(chip => chip.engineId === 'claude'), 'Claude engine selection');
      assert.equal(ui.codexLoggedIn, false);
      assert.equal(ui.thread.profileEnabled, false);
      assert.equal(ui.thread.bindingHeld, false);
      return { ...thread, wireClientThreadId: ui.thread.wireClientThreadId };
    };
    const send = async (thread, scenario, suffix = '') => {
      deadline();
      const prompt = `EGDESK_QA_CLAUDE_${scenario} ${nonce} ${suffix}`.trim();
      await sendFromComposer(harness, prompt); // Never /chat/send directly.
      const state = await waitUntil(readFixture, state => state.observed.sends.some(row => row.message === prompt));
      const sent = state.observed.sends.filter(row => row.message === prompt);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].engineId, 'claude');
      assert.equal(sent[0].profileEnabled, false);
      assert.equal(sent[0].clientThreadId, thread.wireClientThreadId);
      const ready = await waitUntil(readFixture, state => state.runs.find(row => row.runId === sent[0].runId)?.messages.some(row => row.role === 'assistant')
        || state.runs.find(row => row.runId === sent[0].runId)?.fixtureStage != null);
      return ready.runs.find(row => row.runId === sent[0].runId);
    };
    const assertText = async (thread, run) => {
      const ui = await waitUi(ui => ui.messages.some(row => row.runId === run.runId && row.role === 'assistant' && row.text === CLAUDE_FIXTURE_TEXT), 'Claude assistant bubble');
      assert.equal(ui.thread.id, thread.id);
      assert.equal(ui.thread.engineId, 'claude');
      assert.equal(ui.thread.conversationId, run.conversationId);
      assert.equal(ui.thread.bindingHeld, false);
      assert.equal(ui.codexLoggedIn, false);
      assert.equal(ui.messages.find(row => row.runId === run.runId && row.role === 'assistant').author, 'Claude');
      assert.equal(ui.runs.find(row => row.runId === run.runId)?.engineId, 'claude');
    };

    const ordinary = await newClaude('ordinary');
    const first = await send(ordinary, 'TEXT', 'new');
    await assertText(ordinary, first);
    check('actual ordinary send works with Codex auth false and shows Claude', true);
    await newClaude('away');
    const beforeResume = await readFixture();
    await selectQaThread(harness, ordinary);
    const resumed = await waitUntil(readFixture, state => state.observed.resumes.length > beforeResume.observed.resumes.length);
    const resume = resumed.observed.resumes.at(-1);
    assert.deepEqual(resume, { conversationId: first.conversationId, clientThreadId: ordinary.wireClientThreadId, engineId: 'claude' });
    await waitUi(ui => !ui.thread.resuming, 'native resume settled');
    const second = await send(ordinary, 'TEXT', 'resumed');
    assert.equal(second.conversationId, first.conversationId);
    assert.notEqual(second.runId, first.runId);
    await assertText(ordinary, second);
    check('room reopen and second actual send preserve Claude and the original conversation', true);
    await capture('claude-ordinary-resumed');

    for (const offered of [true, false]) {
      const thread = await newClaude(offered ? 'session' : 'no-session');
      const run = await send(thread, offered ? 'SESSION_APPROVAL' : 'APPROVAL_NO_SESSION');
      const approval = run.pendingApprovals[0];
      assertSessionOffer(approval, run.fixtureApprovalOffer, offered);
      await openActivity(harness);
      const selector = `${approvalCard(approval.approvalId)} [data-testid="chat-approval-choice"]`;
      const buttons = await visible(harness, selector);
      assert.deepEqual(buttons.map(row => row.dataset.decision).sort(), [...approval.choices].sort());
      assert.ok(buttons.every(row => !row.disabled));
      const before = await readFixture();
      assert.equal(before.observed.approvals.filter(row => row.runId === run.runId).length, 0);
      const decision = offered ? 'acceptForSession' : 'decline';
      await harness.click(`${selector}[data-decision="${decision}"]`);
      const state = await waitUntil(readFixture, state => state.observed.approvals.some(row => row.runId === run.runId));
      const replies = state.observed.approvals.filter(row => row.runId === run.runId);
      assert.equal(replies.length, 1);
      assert.equal(replies[0].decision, decision);
      assert.equal(replies[0].approvalId, approval.approvalId);
      assert.equal(replies[0].conversationId, run.conversationId);
      check(offered ? 'native session approval uses the server-offered valid session rule (synthetic only)'
        : 'without an offered rule there is no session choice; explicit decline is sent', true);
      await capture(offered ? 'claude-session-approval' : 'claude-no-session-approval');
      await control(run.runId, 'approval');
      await control(run.runId, 'run');
    }

    const questionsThread = await newClaude('questions');
    const questionsRun = await send(questionsThread, 'MULTI_SELECT');
    const input = questionsRun.pendingUserInputs[0];
    await openActivity(harness);
    let ui = await waitUi(ui => ui.questions.some(card => card.id === input.userInputId), 'question cards');
    assertClaudeQuestionUi(input, ui.questions.find(card => card.id === input.userInputId));
    await newClaude('question-away');
    const beforeRestore = await readFixture();
    await selectQaThread(harness, questionsThread);
    await waitUntil(readFixture, state => state.observed.resumes.length > beforeRestore.observed.resumes.length);
    await waitUi(ui => !ui.thread.resuming, 'question snapshot restore');
    await openActivity(harness);
    ui = await waitUi(ui => ui.questions.some(card => card.id === input.userInputId), 'restored questions');
    assert.deepEqual(ui.runs.find(row => row.runId === questionsRun.runId)?.pendingUserInputs[0]?.questions, CLAUDE_FIXTURE_QUESTIONS);
    assertClaudeQuestionUi(input, ui.questions.find(card => card.id === input.userInputId));
    check('room history snapshot preserves every question, option and multiSelect checkbox', true);
    await selectClaudeQuestionAnswers(harness, input);
    ui = await observeClaudeUi(harness);
    assert.deepEqual(ui.questions.find(card => card.id === input.userInputId).options.filter(row => row.checked)
      .map(row => [row.questionId, row.optionIndex]), [['q0', '0'], ['q0', '2'], ['q1', '1']]);
    assert.equal((await readFixture()).observed.userInputs.length, 0, 'Checkbox selection cannot auto-submit');
    await harness.click(`${inputCard(input.userInputId)} [data-testid="chat-user-input-submit"]`);
    const answered = await waitUntil(readFixture, state => state.observed.userInputs.length > 0);
    assert.equal(answered.observed.userInputs.length, 1);
    assertClaudeAnswers(answered.observed.userInputs[0], questionsRun, input);
    check('native checkbox choices submit optionIndices [0,2], preserving the single-choice optionIndex', true);
    await capture('claude-checkbox-answer');
    await control(questionsRun.runId, 'userInput');
    await control(questionsRun.runId, 'run');

    const rateThread = await newClaude('quota');
    const rateRun = await send(rateThread, 'RATE_LIMIT');
    const assertRate = async (run, level) => {
      const ui = await waitUi(ui => ui.rates.some(row => row.level === level), `quota ${level}`);
      // Independent clock observation, not product formatter output used as its own oracle.
      const clock = await chrome(harness, at => {
        const date = new Date(at), hours = date.getHours();
        return `${hours < 12 ? '오전' : '오후'} ${hours % 12 || 12}:${String(date.getMinutes()).padStart(2, '0')}`;
      }, run.rateLimit.resetsAt);
      assertClaudeRateUi(run, ui, level, clock);
    };
    await assertRate(rateRun, 'warn');
    check('run.rateLimit warning renders Claude usage and the reported reset clock', true);
    await control(rateRun.runId, 'claude-rate-rejected');
    const rejected = await readFixture(), rejectedRun = rejected.runs.find(row => row.runId === rateRun.runId);
    await assertRate(rejectedRun, 'limit');
    await waitUntil(async () => { deadline(); return Date.now(); }, now => now >= rejectedRun.rateLimit.resetsAt + 750,
      { timeoutMs: 6000, intervalMs: 100 });
    assertNoAutomaticRequests(rejected, await readFixture());
    check('rejected quota displays reset time without automatic send/resume through reset +750ms', true);
    await capture('claude-rate-limit');

    const contextThread = await newClaude('context-blocked');
    // Strict fixture setup 3: seed only the manifest's own reference file into
    // a fresh ordinary Claude draft. No OS picker, capture, file read or send.
    await chrome(harness, ({ threadId, profile, artifactPath }) => {
      const api = window.__egdesk, codex = api.state.codex;
      const thread = codex.threads.find(row => row.id === codex.activeThreadId);
      const ChatState = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
      if (thread?.id !== threadId || thread.conversationId || thread.messages.length || thread.profileEnabled
          || thread.inputSources?.length || ChatState.chatThreadEngineId(thread, codex) !== 'claude'
          || artifactPath !== `${profile}/qa-fixtures/fixture-reference.txt`) throw new Error('Unsafe Context fixture setup');
      api.codexBridge.addInputSources(threadId, [{ id: 'qa-claude-context', kind: 'file', label: 'QA Claude Context fixture',
        sourceRef: { path: artifactPath } }]);
      return true;
    }, { threadId: contextThread.id, profile: options.profile, artifactPath: manifest.artifactPath });
    const contextPrompt = `EGDESK_QA_CLAUDE_CONTEXT_BLOCKED ${nonce}`;
    await replaceComposerText(harness, contextPrompt);
    const beforeContext = await observeClaudeUi(harness), beforeContextFixture = await readFixture();
    await sendFromComposer(harness, contextPrompt);
    const blocked = await waitUi(ui => ui.thread.sendError === CLAUDE_CONTEXT_ERROR, 'exact Context refusal');
    assertClaudeContextBlocked(beforeContext, blocked, beforeContextFixture, await readFixture());
    check('Context blocks before HTTP capture/send and preserves the exact draft and selected attachment', true);
    await capture('claude-context-blocked');
    assertClaudeReady(await loopbackJson('/v1/state'));
    const final = await readFixture();
    assert.equal(final.observed.authWrites.length, 0);
    assert.equal(final.observed.blockedContexts.length, 0, 'UI must refuse before backend Context safety fallback');
    assert.equal(final.context.captureBatches, 0);
    result.fixtureRequests = { sends: final.observed.sends.length, resumes: final.observed.resumes.length,
      approvals: final.observed.approvals.length, userInputs: final.observed.userInputs.length };
    check('Codex remains signed out; no login/logout, Context capture, real provider or OS action', true);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runClaudeFixtureFlow(claudeFixtureOptions(process.argv.slice(2))); }
  catch (error) {
    process.stderr.write(`Claude fixture preflight: ${error.message}\n`);
    process.exitCode = 1;
  }
}
