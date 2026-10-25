#!/usr/bin/env node
// Main-owned, model-free UI proof. Importing this module starts nothing.
// Actions use the profile-bound MCP harness. Chrome evaluation only observes,
// except the named, owned fixture setup operations below. Never calls an adapter.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { qaBridgeConfig, validateQaFixtureIsolation } from './egdesk-qa-fixture-isolation.mjs';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { CLAUDE_FIXTURE_TEXT, CLAUDE_FIXTURE_QUESTIONS, CLAUDE_CONTEXT_TOOLS } from './egdesk-chat-fixture-transport.mjs';
import { fingerprintQaBytes, observeQaFixtureFile } from './egdesk-context-qa-contract.mjs';
import { runUiFlow, chrome, loopbackJson, newQaThread, selectQaThread, sendFromComposer,
  replaceComposerText, visible, waitUntil, openChat, chatShellUsable } from './egdesk-qa-ui-flow.mjs';

export const CLAUDE_CONTEXT_ERROR = '현재 Claude 연결에서는 선택한 자료를 사용할 수 없어 보내지 않았습니다. 자료를 제외한 뒤 다시 보내세요.';
export const CLAUDE_READER_ERROR = '현재 Claude 연결에서는 이 자료의 Smart Read를 지원하지 않아 보내지 않았습니다. 더 작은 완전한 자료를 선택하거나 Codex 대화에서 다시 시도해 주세요. 초안과 선택 자료는 유지됩니다.';
const PANEL = '#egd-codex-activity-panel';
const INPUT_PANEL = '#egd-codex-input-panel';
const ENGINE_PICKER = '[data-testid="chat-engine-panel"][role="dialog"][aria-label="AI 엔진 설정"]';
const inputCard = id => `${PANEL} [data-testid="chat-user-input"][data-user-input-id=${JSON.stringify(id)}]`;
const approvalCard = id => `${PANEL} [data-testid="chat-approval"][data-approval-id=${JSON.stringify(id)}]`;

export function claudeFixtureOptions(argv, env = process.env, now = Date.now()) {
  const options = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], value = argv[i + 1];
    assert.ok(['--profile', '--deadline-utc', '--reader-mode'].includes(key) && value && !value.startsWith('--') && !options.has(key),
      'Expected --profile PATH, optional --deadline-utc UTC_ISO_TIMESTAMP and --reader-mode unavailable|synthetic');
    options.set(key, value);
  }
  const profile = options.get('--profile');
  assert.ok(profile && path.isAbsolute(profile), 'An explicit absolute QA --profile is required');
  const bridge = qaBridgeConfig(env);
  assert.ok(bridge.fixture && env.EGDESK_QA_CLAUDE_FIXTURE === '1', 'Explicit isolated Claude fixture mode required');
  assert.equal(env.EGDESK_QA_REAL_TURN, '0', 'Explicit real-provider turn zero is required');
  assert.equal(env.MOZ_HEADLESS, '1', 'Claude fixture UI proof is headless-only');
  assert.equal(String(env.EGDESK_MARIONETTE_PORT || '2829'), '2829', 'Only Main-owned QA Marionette 2829 is allowed');
  assert.ok(![2828, 2829, 6000, 6001].includes(bridge.port), 'Fixture must not share an automation port');
  assert.equal(bridge.port, 39220, 'Only the Main-owned fixture port 39220 is allowed');
  assert.ok(typeof env.EGDESK_QA_FIXTURE_TOKEN === 'string' && env.EGDESK_QA_FIXTURE_TOKEN.length >= 16, 'Fixture control token required');
  const utc = options.get('--deadline-utc');
  if (utc) assert.match(utc, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/, 'Deadline must be an explicit UTC ISO timestamp');
  const deadlineMs = utc ? Date.parse(utc) : now + 6 * 60_000;
  assert.ok(Number.isFinite(deadlineMs) && deadlineMs > now && deadlineMs - now <= 15 * 60_000,
    'Deadline must be in the future and within 15 minutes');
  const readerMode = options.get('--reader-mode') || 'unavailable';
  assert.ok(['unavailable', 'synthetic'].includes(readerMode), 'Reader mode must be unavailable or explicitly synthetic');
  assert.equal(env.EGDESK_QA_CLAUDE_READER_FIXTURE === '1', readerMode === 'synthetic', 'Verifier and fixture Reader opt-in must match');
  assert.ok(env.EGDESK_QA_CLAUDE_READER_FIXTURE == null || ['0', '1'].includes(env.EGDESK_QA_CLAUDE_READER_FIXTURE), 'Invalid Reader fixture gate');
  return { profile, bridge, deadlineMs, readerMode };
}

export function assertClaudeFixturePeer(peer, { profile, bridge, readerMode }) {
  assert.equal(peer.fixture, true);
  assert.equal(peer.claudeFixture, true, 'Start the separate Claude fixture, not the Chat72 fixture');
  assert.equal(peer.profile, profile, 'Fixture must belong to the exact QA profile');
  assert.equal(peer.host, bridge.host);
  assert.equal(peer.port, bridge.port);
  assert.equal(peer.origin, bridge.origin);
  assert.equal(peer.providerTurns, 0);
  if (readerMode === 'synthetic') assert.equal(peer.claudeReaderFixture, true, 'B3 proof requires the explicitly synthetic Reader fixture');
  else assert.notEqual(peer.claudeReaderFixture, true, 'B2 proof cannot silently run against a B3 fixture');
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
  for (const key of ['sends', 'resumes', 'interrupts', 'approvals', 'userInputs', 'authWrites', 'blockedContexts', 'captures', 'contextRefusals']) {
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

function assertContextDraftPreserved(before, after, message) {
  assert.equal(after.thread.id, before.thread.id);
  assert.equal(after.thread.engineId, 'claude');
  assert.equal(after.thread.sendError, message);
  assert.ok(after.alerts.includes(message), 'Exact Context error must be visible');
  assert.ok(before.composer && before.thread.inputSources.length === 1, 'A draft and one selected fixture are required');
  assert.equal(after.composer, before.composer);
  assert.equal(after.thread.draft, before.thread.draft);
  assert.equal(after.thread.draft, after.composer);
  assert.deepEqual(after.thread.inputSources, before.thread.inputSources);
  assert.deepEqual(after.attachments, before.attachments);
  assert.equal(after.attachments.length, 1);
  assert.equal(after.thread.conversationId, null);
}

export function assertClaudeContextBlocked(before, after, beforeFixture, afterFixture) {
  assertContextDraftPreserved(before, after, CLAUDE_CONTEXT_ERROR);
  assertNoAutomaticRequests(beforeFixture, afterFixture);
}

export function assertClaudeReaderBlocked(before, after, beforeFixture, afterFixture, { message = CLAUDE_READER_ERROR, code = 'CLAUDE_CONTEXT_READER_UNSUPPORTED' } = {}) {
  assertContextDraftPreserved(before, after, message);
  for (const key of ['sends', 'resumes', 'interrupts', 'approvals', 'userInputs', 'authWrites', 'blockedContexts']) {
    assert.deepEqual(afterFixture.observed[key], beforeFixture.observed[key], `Rejected source cannot cause ${key}`);
  }
  assert.equal(afterFixture.runs.length, beforeFixture.runs.length);
  assert.deepEqual(afterFixture.context.deliveries, beforeFixture.context.deliveries);
  assert.deepEqual(afterFixture.context.inspectorReads, beforeFixture.context.inspectorReads);
  assert.equal(afterFixture.context.captureBatches, beforeFixture.context.captureBatches + 1);
  assert.equal(afterFixture.context.fileCaptureOperations, beforeFixture.context.fileCaptureOperations + 1);
  assert.deepEqual(afterFixture.observed.captures.slice(0, -1), beforeFixture.observed.captures);
  const attempt = afterFixture.observed.captures.at(-1);
  assertClaudeContextRoute(attempt.request, before.thread);
  assert.equal(attempt.request.attachments.length, 1);
  assert.equal(attempt.request.attachments[0].sourceRef.path, before.thread.inputSources[0].sourceRef.path);
  assert.deepEqual(afterFixture.observed.contextRefusals, [...beforeFixture.observed.contextRefusals,
    { route: '/chat/send', code }]);
}

export function assertClaudeContextRoute(request, thread, { reader = false } = {}) {
  assert.equal(request.engineId, 'claude');
  assert.equal(request.engineProfileId, 'claude-default');
  assert.equal(request.engineProfileId, thread.engineProfileId);
  assert.equal(request.clientThreadId, thread.wireClientThreadId);
  assert.ok(typeof request.expectedContextScope === 'string' && request.expectedContextScope.length > 0
    && request.expectedContextScope.length <= 512, 'Selected Context must echo the opaque server-issued expectation');
  for (const key of ['ownerKey', 'epoch', 'ownerScope', 'contextAuthority', 'selectedSources', 'browserToolSelection', 'executionPolicy']) {
    assert.ok(!Object.hasOwn(request, key), `Unexpected UI authority or browser/OS grant: ${key}`);
  }
  if (request.contextCapabilities != null) assert.deepEqual(request.contextCapabilities,
    { read: true, reader, publishBriefing: false });
}

export function assertClaudeContextCapture(before, after, thread, run, sourceFile, originalText, options) {
  assert.equal(after.observed.sends.length, before.observed.sends.length + 1);
  assert.equal(after.observed.captures.length, before.observed.captures.length + 1);
  const sent = after.observed.sends.at(-1), attempt = after.observed.captures.at(-1);
  assertClaudeContextRoute(sent, thread, options);
  assertClaudeContextRoute(attempt.request, thread, options);
  assert.equal(sent.expectedContextScope, attempt.request.expectedContextScope, 'Capture and send must retain the same expectation, not silently refresh it');
  assert.equal(sent.runId, run.runId);
  assert.equal(run.clientThreadId, thread.wireClientThreadId);
  assert.equal(run.engineId, 'claude');
  assert.equal(run.fixtureStage, 'context-bound');
  assert.deepEqual(run.fixtureContextTools, ['egdesk_list_context', 'egdesk_read_source']);
  assert.equal(attempt.request.attachments.length, 1);
  assert.equal(attempt.request.attachments[0].kind, 'file');
  assert.equal(attempt.request.attachments[0].sourceRef.path, sourceFile);
  assert.equal(attempt.captures.length, 1);
  const captured = attempt.captures[0];
  assert.equal(captured.sourceRef.path, sourceFile);
  assert.equal(captured.snapshotId, captured.sourceId);
  assert.equal(captured.version, 1);
  assert.equal(captured.hash, fingerprintQaBytes(originalText).sha256);
  assert.equal(captured.truncated, false);
  assert.deepEqual(run.contextCaptures, [captured]);
  assert.deepEqual(sent.contextSnapshotIds, [captured.sourceId]);
  assert.equal(after.context.captureBatches, before.context.captureBatches + 1);
  assert.equal(after.context.fileCaptureOperations, before.context.fileCaptureOperations + 1);
  assert.deepEqual(after.context.deliveries, before.context.deliveries, 'Capture and binding are not read/delivery proof');
  return captured;
}

export function assertClaudeImmutablePacket(delivery, captured, run, originalText, changedText) {
  assert.notEqual(originalText, changedText);
  assert.equal(captured.hash, fingerprintQaBytes(originalText).sha256);
  assert.notEqual(captured.hash, fingerprintQaBytes(changedText).sha256);
  assert.equal(delivery.fixtureOnly, true);
  assert.equal(delivery.sourceId, captured.sourceId);
  assert.equal(delivery.toolName, 'egdesk_read_source');
  const packet = delivery.packet, value = JSON.parse(packet.text);
  assert.equal(packet.mode, 'qa-fixture-claude-direct-read');
  assert.equal(packet.role, 'agent_input');
  assert.equal(packet.deliveryStatus, 'sent-to-app-server'); // Synthetic receipt only, never actual adapter proof.
  assert.equal(packet.hash, fingerprintQaBytes(packet.text).sha256);
  assert.deepEqual(packet.binding, { conversationId: run.conversationId, runId: run.runId, answerId: run.answerId });
  const coverage = { sourceId: captured.sourceId, range: { startLine: 1, endLine: originalText.split('\n').length },
    totalLines: originalText.split('\n').length, complete: true, sourceTruncated: false };
  assert.deepEqual(value, { fixtureOnly: true, tool: 'egdesk_read_source', sourceId: captured.sourceId,
    snapshotId: captured.sourceId, sourceHash: captured.hash, version: captured.version, text: originalText, coverage });
  assert.deepEqual(packet.coverage, coverage);
}

export function assertClaudeReaderDescriptor(descriptor, thread, reader) {
  assert.equal(descriptor.contract, 'egdesk-context-b2', 'B3 must preserve B2 readiness');
  assert.equal(descriptor.engineId, 'claude');
  assert.equal(descriptor.engineProfileId, thread.engineProfileId);
  assert.equal(descriptor.selectedAttachments, true);
  assert.equal(descriptor.immutableRead, true);
  assert.equal(descriptor.nativeReader, reader, 'Reader availability must be explicit server evidence');
  if (reader || descriptor.largeReader != null) {
    assert.equal(descriptor.largeReader, reader);
    assert.equal(descriptor.reader?.ready, reader);
    assert.equal(descriptor.reader?.engineId, 'claude');
    if (reader) assert.equal(descriptor.reader.code, null);
    else assert.ok(['CLAUDE_CONTEXT_READER_UNSUPPORTED', 'ENGINE_CAPACITY_UNKNOWN', 'READER_ISOLATION_UNAVAILABLE'].includes(descriptor.reader.code));
  }
  assert.deepEqual([...descriptor.tools].sort(), [...CLAUDE_CONTEXT_TOOLS].sort());
  assertClaudeContextRoute({ ...thread, clientThreadId: thread.wireClientThreadId,
    expectedContextScope: descriptor.expectedContextScope }, thread);
}

export function assertClaudeReaderProcessed(before, after, run, captured, originalText, reviewed) {
  assert.deepEqual(after.context.deliveries, before.context.deliveries, 'Reader processed is not Main received');
  assert.equal(after.context.readerProcessed.length, (before.context.readerProcessed?.length || 0) + 1);
  const records = after.context.readerProcessed.filter(row => row.runId === run.runId);
  assert.equal(records.length, reviewed);
  let nextOffset = 0;
  for (const record of records) {
    assert.equal(record.sourceId, captured.sourceId);
    assert.equal(record.fixtureOnly, true);
    assert.equal(record.adapterExecutionVerified, false);
    assert.equal(record.inputPayload.hash, fingerprintQaBytes(record.inputPayload.text).sha256);
    const input = JSON.parse(record.inputPayload.text);
    assert.equal(input.fixtureOnly && input.synthetic, true);
    assert.equal(input.sourceId, captured.sourceId);
    assert.equal(input.sourceHash, captured.hash);
    assert.equal(input.range.startOffset, nextOffset, 'Assigned source partitions must be contiguous');
    assert.ok(Number.isInteger(input.range.endOffset) && input.range.endOffset > nextOffset && input.range.endOffset <= originalText.length);
    assert.equal(input.sourceText, originalText.slice(nextOffset, input.range.endOffset));
    nextOffset = input.range.endOffset;
  }
  const event = after.observed.events.at(-1);
  assert.equal(event.event, 'reader.completed');
  assert.equal(event.runId, run.runId);
  assert.equal(event.details.deliveryStatus, 'prepared');
  assert.equal(event.details.coverage.complete, nextOffset === originalText.length, 'A clipped summary cannot establish complete input coverage');
}

export function assertClaudeReaderPacket(delivery, captured, run, originalText, { reviewed, total, sessionId }) {
  assert.equal(delivery.fixtureOnly, true);
  assert.equal(delivery.sourceId, captured.sourceId);
  assert.equal(delivery.toolName, 'egdesk_read_source');
  assert.equal(captured.hash, fingerprintQaBytes(originalText).sha256);
  const packet = delivery.packet, value = JSON.parse(packet.text);
  assert.equal(packet.role, 'agent_input');
  assert.equal(packet.mode, 'qa-fixture-claude-reader');
  assert.equal(packet.hash, fingerprintQaBytes(packet.text).sha256);
  assert.equal(packet.deliveryStatus, 'sent-to-app-server'); // Synthetic receipt only.
  assert.deepEqual(packet.binding, { conversationId: run.conversationId, runId: run.runId, answerId: run.answerId });
  assert.equal(value.fixtureOnly && value.synthetic, true);
  assert.equal(value.adapterExecutionVerified, false);
  assert.equal(value.mode, 'reader');
  assert.equal(value.tool, 'egdesk_read_source');
  assert.equal(value.sourceId, captured.sourceId);
  assert.equal(value.snapshotId, captured.sourceId);
  assert.equal(value.sourceHash, captured.hash);
  assert.equal(value.version, captured.version);
  assert.ok(Number.isInteger(total) && total > 1 && Number.isInteger(reviewed) && reviewed > 0 && reviewed <= total);
  assert.equal(value.summary.text, `Synthetic QA Reader: ${reviewed}/${total} partitions processed; no model invoked.`);
  assert.deepEqual(value.summary.structure, [{ label: 'QA coverage only', text: 'Not a real model summary or whole-source quotation.' }]);
  assert.deepEqual(value.selectedSpans, [{ startOffset: 0, endOffset: Math.min(80, originalText.length), quote: originalText.slice(0, 80) }]);
  assert.deepEqual(value.coverage, { scope: 'capture', sourceId: captured.sourceId, complete: reviewed === total,
    sourceTruncated: false, reviewedPartitions: reviewed, totalPartitions: total,
    continuation: reviewed < total ? { readerSessionId: sessionId, nextPartition: reviewed } : null });
  assert.deepEqual(packet.coverage, value.coverage);
  assert.deepEqual(value.reader, { sessionId, revision: reviewed });
  assert.deepEqual(value.omissionPolicy, { type: 'reader-summary', fixtureOnly: true });
  assert.ok(!Object.hasOwn(value, 'text') && !Object.hasOwn(value, 'nativeThreadId'), 'A synthetic summary is not a raw source or native-model receipt');
}

export function claudeReaderPartialCaptureLabel(reviewed, total) {
  assert.ok(Number.isSafeInteger(total) && total > 1 && Number.isSafeInteger(reviewed) && reviewed > 0 && reviewed < total,
    'Partial Reader capture requires a completed step before the final partition');
  return `claude-reader-partial-structured-summary-step-${reviewed}-of-${total}`;
}

export function assertClaudeReaderEnded(before, after, run, captured, status) {
  assert.ok(['failed', 'interrupted'].includes(status));
  const ended = after.runs.find(row => row.runId === run.runId);
  assert.equal(ended.status, status);
  assert.deepEqual(ended.contextCaptures, [captured]);
  assert.equal(ended.messages.some(row => row.role === 'assistant'), false);
  assert.deepEqual(after.observed.sends, before.observed.sends, 'No automatic fallback send');
  assert.deepEqual(after.observed.captures, before.observed.captures, 'No automatic recapture');
  assert.deepEqual(after.observed.resumes, before.observed.resumes, 'No automatic fallback resume');
  assert.deepEqual(after.context.deliveries, before.context.deliveries, 'Failed/cancelled Reader must not deliver');
  assert.equal(after.observed.events.some(row => row.runId === run.runId &&
    (row.event === 'context.read.completed' || row.event === 'run.completed' && row.details.status === 'completed')), false);
  assert.equal(after.providerTurns, 0);
}

// Read-only checkbox observations; all changes below go through MCP click.
export const observeAttachmentChoices = (harness, selector) => chrome(harness, rootSelector =>
  [...document.querySelectorAll(`${rootSelector} [data-testid="chat-attach-source"]`)].map(node => ({
    viewId: node.dataset.viewId, checked: node.checked, type: node.type, disabled: node.disabled,
  })), selector);

export async function selectClaudeAttachment(harness, threadId, targetViewId, ownedViewIds) {
  assert.ok(threadId && targetViewId && ownedViewIds.includes(targetViewId));
  await harness.click('[data-testid="chat-attach-open"]');
  const panel = `${INPUT_PANEL}[data-thread-id=${JSON.stringify(threadId)}]`;
  assert.equal((await visible(harness, panel)).length, 1, 'Expected the actual current-room attachment picker');
  const choices = await observeAttachmentChoices(harness, panel);
  assert.equal(new Set(choices.map(row => row.viewId)).size, choices.length, 'Ambiguous source choices');
  assert.equal(choices.filter(row => row.viewId === targetViewId).length, 1, 'Owned source must be offered exactly once');
  const target = choices.find(row => row.viewId === targetViewId);
  assert.equal(target.type, 'checkbox');
  assert.equal(target.disabled, false);
  assert.ok(choices.every(row => !row.checked || ownedViewIds.includes(row.viewId)), 'Cannot alter unrelated preselected sources');
  for (const row of choices) if (row.checked !== (row.viewId === targetViewId)) {
    assert.equal(row.type, 'checkbox');
    assert.equal(row.disabled, false);
    const selector = `${panel} [data-testid="chat-attach-source"][data-view-id=${JSON.stringify(row.viewId)}]`;
    const controls = await visible(harness, selector);
    assert.equal(controls.length, 1, 'Expected one visible source checkbox');
    await harness.click(selector);
  }
  const selected = (await observeAttachmentChoices(harness, panel)).filter(row => row.checked);
  assert.deepEqual(selected.map(row => row.viewId), [targetViewId]);
  await harness.click(`${panel} [data-testid="chat-attach-confirm"]`);
}

export const observeClaudeContextInspector = harness => chrome(harness, selector => {
  const panel = document.querySelector(selector);
  const articles = panel ? [...panel.querySelectorAll('[data-testid="chat-input-snapshot"]')] : [];
  const article = articles.length === 1 ? articles[0] : null;
  const source = article?.querySelector('[aria-label="당시 캡처 본문"]');
  const payload = article?.querySelector('[aria-label="실제로 전달된 payload 원문"]');
  const shown = node => !!node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0
    && getComputedStyle(node).visibility !== 'hidden' && getComputedStyle(node).display !== 'none';
  return { threadId: panel?.dataset.threadId, articleCount: articles.length, sourceId: article?.dataset.snapshotId,
    sourceText: source?.textContent, sourceVisible: shown(source),
    sourceLabel: article?.querySelector('[data-testid="chat-input-source-label"]')?.textContent,
    sourceMetadata: article?.querySelector('[data-testid="chat-input-source-details"]')?.textContent,
    packetId: article?.querySelector('[data-testid="chat-input-delivery"]')?.dataset.packetId,
    payloadText: payload?.textContent, payloadVisible: shown(payload) };
}, INPUT_PANEL);

export function assertClaudeContextInspector(observed, thread, captured, delivery, originalText) {
  assert.equal(observed.threadId, thread.id);
  assert.equal(observed.articleCount, 1);
  assert.equal(observed.sourceId, captured.sourceId);
  assert.equal(observed.sourceText, originalText);
  assert.equal(observed.sourceVisible, true);
  assert.ok(observed.sourceLabel?.includes('원문 캡처'));
  assert.ok(observed.sourceMetadata?.includes(captured.hash));
  assert.equal(observed.packetId, delivery.packet.packetId);
  assert.equal(observed.payloadText, delivery.packet.text);
  assert.equal(observed.payloadVisible, true);
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
    threadIds: codex.threads.map(item => item.id),
    thread: thread && { id: thread.id, title: thread.title, engineId: ChatState.chatThreadEngineId(thread, codex),
      engineProfileId: ChatState.chatThreadEngineProfileId(thread, codex),
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
    contextActivities: nodes('[data-testid="chat-context-activity"]').map(node => ({ event: node.dataset.event, sourceId: node.dataset.sourceId, text: node.textContent })),
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

// Owned file-card setup changes the camera target before the next animation
// frame. A momentarily visible Chat is not yet safe for Back/New-room clicks.
// Observe settlement, then use the existing native Dock return (never setters).
export const observeClaudeFixtureViewport = harness => chrome(harness, () => {
  const box = node => {
    const rect = node?.getBoundingClientRect();
    return rect ? { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
      width: rect.width, height: rect.height } : null;
  };
  const shells = [...document.querySelectorAll('.egd-codex-chat-shell')];
  const shell = shells.length === 1 ? shells[0] : null;
  const state = window.__egdesk.state;
  const navigation = [...shell?.querySelectorAll('.egd-codex-conversation-back, .egd-codex-thread-home-new') || []]
    .filter(node => {
      const rect = box(node), style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    }).map(node => {
      const rect = box(node), hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return { rect, disabled: node.disabled, hittable: !!hit && (hit === node || node.contains(hit)) };
    });
  return { shellCount: shells.length, shell: box(shell), dock: box(document.getElementById('egd-dock')),
    view: { width: window.innerWidth, height: window.innerHeight }, navigation,
    camera: { pan: { ...state.pan }, panTarget: { ...state.panTarget }, zoom: state.zoom, zoomTarget: state.zoomTarget } };
});

export function claudeFixtureCameraSettled({ camera } = {}) {
  return !!camera && [camera.pan?.x, camera.pan?.y, camera.panTarget?.x, camera.panTarget?.y, camera.zoom, camera.zoomTarget].every(Number.isFinite)
    && Math.abs(camera.pan.x - camera.panTarget.x) <= 0.5 && Math.abs(camera.pan.y - camera.panTarget.y) <= 0.5
    && camera.zoom > 0 && camera.zoomTarget > 0 && Math.abs(camera.zoom - camera.zoomTarget) <= 0.001;
}

export function claudeFixtureChatNavigable(observed) {
  if (!claudeFixtureCameraSettled(observed) || observed.shellCount !== 1
      || !chatShellUsable(observed.shell, observed.dock, observed.view) || observed.navigation?.length !== 1) return false;
  const control = observed.navigation[0], rect = control.rect;
  return !!rect && control.disabled === false && control.hittable === true && rect.width > 0 && rect.height > 0
    && rect.left >= 0 && rect.top >= 0 && rect.right <= observed.view.width && rect.bottom <= observed.view.height;
}

export async function returnClaudeChatAfterFixtureSetup(harness) {
  const before = await observeClaudeFixtureViewport(harness);
  const stable = async predicate => {
    let samples = 0;
    return waitUntil(() => observeClaudeFixtureViewport(harness), observed => {
      samples = predicate(observed) ? samples + 1 : 0;
      return samples >= 2;
    }, { timeoutMs: 10000, intervalMs: 100 });
  };
  const settled = await stable(claudeFixtureCameraSettled);
  await openChat(harness); // Existing actual Dock click only when Chat is not usable.
  const returned = await stable(claudeFixtureChatNavigable);
  return { action: 'existing-native-Dock-return-after-owned-file-card-setup', before, settled, returned };
}

export async function runClaudeFixtureFlow(options) {
  // Before connecting, validate the exact owned profile, manifest, original and
  // transformed hashes. The shared harness repeats this gate independently.
  validateQaFixtureIsolation(options.profile);
  const manifest = assertQaFixtureManifest(options.profile);
  const token = process.env.EGDESK_QA_FIXTURE_TOKEN;
  const readerEnabled = options.readerMode === 'synthetic';
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
  const contextControl = async (runId, phase) => {
    await readFixture();
    return loopbackJson('/__qa/context-release', { method: 'POST', token, body: { runId, phase } });
  };
  const readerDescriptor = async (thread, ready) => {
    deadline();
    const descriptor = await loopbackJson(`/context/capabilities?${new URLSearchParams({ engineId: 'claude',
      engineProfileId: thread.engineProfileId, clientThreadId: thread.wireClientThreadId,
      ...(thread.conversationId ? { conversationId: thread.conversationId } : {}) })}`);
    assertClaudeReaderDescriptor(descriptor, { ...thread, engineId: 'claude' }, ready);
    return descriptor;
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
    result.readerMode = options.readerMode;
    result.actualModelReadVerified = false;
    result.deadlineUtc = new Date(options.deadlineMs).toISOString();
    result.scope = 'Visible Claude UI and selected immutable Context/optional bounded Reader receipts with Codex offline; synthetic fixture only, not actual model reading, permission persistence, full restart, capacity discovery or backend adapter proof';
    result.fixtureSetup = ['owned headless viewport', 'new-room QA title metadata',
      'two exclusive manifest-owned text files and file-URL cards', 'native Dock return after owned file-card camera settlement',
      'controlled mutation of the owned small source after capture'];
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
      assert.equal(ui.thread.engineProfileId, 'claude-default');
      return { ...thread, wireClientThreadId: ui.thread.wireClientThreadId, engineProfileId: ui.thread.engineProfileId };
    };
    const send = async (thread, scenario, suffix = '') => {
      deadline();
      const prompt = `EGDESK_QA_CLAUDE_${scenario} ${nonce} ${suffix}`.trim();
      await sendFromComposer(harness, prompt); // Never /chat/send directly.
      const state = await waitUntil(readFixture, state => state.observed.sends.some(row => row.message === prompt));
      const sent = state.observed.sends.filter(row => row.message === prompt);
      assert.equal(sent.length, 1);
      assert.equal(sent[0].engineId, 'claude');
      assert.equal(sent[0].engineProfileId, thread.engineProfileId);
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

    // Strict fixture setup 3: new exclusive text files under the validated QA
    // manifest root, plus their file-URL cards. Selection is never injected.
    deadline();
    const sourceFile = path.join(manifest.root, `claude-context-${nonce}.txt`);
    const largeFile = path.join(manifest.root, `claude-context-large-${nonce}.txt`);
    const originalText = `QA_CLAUDE_V1_${nonce}\nImmutable selected source.\nNo model/provider was invoked.`;
    const changedText = `QA_CLAUDE_V2_${nonce}\nThe live file changed after the capture.\nDo not substitute these bytes.`;
    fs.writeFileSync(sourceFile, originalText, { flag: 'wx', mode: 0o600 });
    const largeOriginal = `QA_CLAUDE_LARGE_${nonce}\n${'Complete fixture source requiring Smart Read.\n'.repeat(600)}`;
    const largeChanged = `QA_CLAUDE_LARGE_CHANGED_${nonce}\n${'Changed live source must not replace captured Reader input.\n'.repeat(600)}`;
    fs.writeFileSync(largeFile, largeOriginal, { flag: 'wx', mode: 0o600 });
    const originalFile = observeQaFixtureFile(options.profile, sourceFile);
    observeQaFixtureFile(options.profile, largeFile);
    const ownedUrls = [sourceFile, largeFile].map(file => pathToFileURL(file).href);
    const scene = await chrome(harness, ({ rootUrl, urls }) => {
      if (!rootUrl.startsWith('file:') || urls.length !== 2 || new Set(urls).size !== 2
          || urls.some(url => !url.startsWith(rootUrl) || !/^claude-context-(?:large-)?[a-z0-9]+\.txt$/.test(url.slice(rootUrl.length)))) {
        throw new Error('Unsafe owned Context fixture card setup');
      }
      return urls.map(url => window.__egdesk.cardRuntime.openBrowserCard(url, { openMode: 'new' }).id);
    }, { rootUrl: `${pathToFileURL(manifest.root).href}/`, urls: ownedUrls });
    assert.equal(scene.length, 2);
    assert.equal(new Set(scene).size, 2);
    assert.ok(scene.every(id => typeof id === 'string' && id));
    result.fixtureCameraReturn = await returnClaudeChatAfterFixtureSetup(harness);
    const attach = async (thread, viewId, file) => {
      const before = await readFixture();
      await selectClaudeAttachment(harness, thread.id, viewId, scene);
      const ui = await waitUi(ui => ui.thread.inputSources.length === 1
        && ui.thread.inputSources[0].sourceRef?.path === file, 'actual attachment checkbox confirmation');
      assert.equal(ui.thread.inputSources[0].sourceRef.viewId, viewId);
      assert.equal(ui.attachments.length, 1);
      assertNoAutomaticRequests(before, await readFixture());
      return ui;
    };
    const contextThread = await newClaude('context-selected');
    await readerDescriptor(contextThread, readerEnabled);
    await attach(contextThread, scene[0], sourceFile);
    check('actual attach picker selects only the owned source; selection alone does not capture or send', true);
    const beforeContext = await readFixture();
    const contextRun = await send(contextThread, 'CONTEXT', 'immutable-selected');
    const contextBound = await readFixture();
    const captured = assertClaudeContextCapture(beforeContext, contextBound, contextThread, contextRun, sourceFile, originalText, { reader: readerEnabled });
    check('actual send binds the exact source/hash/version and only list/read tools to the selected Claude thread', true);

    // Strict fixture setup 4: mutate only the file created above, not the
    // product, copied overlay, personal profile or previously captured bytes.
    assert.deepEqual(observeQaFixtureFile(options.profile, sourceFile), originalFile);
    const fd = fs.openSync(sourceFile, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
    try { fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, changedText); } finally { fs.closeSync(fd); }
    const changedFile = observeQaFixtureFile(options.profile, sourceFile);
    assert.equal(changedFile.sha256, fingerprintQaBytes(changedText).sha256);
    await readFixture();
    await loopbackJson('/__qa/context-release', { method: 'POST', token, body: { runId: contextRun.runId, phase: 'read' } });
    const afterRead = await readFixture();
    assert.equal(afterRead.context.deliveries.length, beforeContext.context.deliveries.length + 1);
    const delivery = afterRead.context.deliveries.at(-1);
    assertClaudeImmutablePacket(delivery, captured, contextRun, originalText, changedText);
    check('synthetic read receipt retains the complete original source/version after live-file mutation; not a model-read claim', true);

    const inspectHistory = async (label, record = { thread: contextThread, run: contextRun, captured, delivery, text: originalText }) => {
      const { thread, run, captured: source, delivery: receipt, text } = record;
      await openActivity(harness);
      const history = `${PANEL} [data-testid="chat-input-history"][data-run-id=${JSON.stringify(run.runId)}]`;
      assert.equal((await visible(harness, history)).length, 1);
      if (!(await chrome(harness, selector => document.querySelector(selector)?.open === true, history))) await harness.click(`${history} > summary`);
      await harness.click(`${history} [data-testid="chat-input-history-open"][data-snapshot-id=${JSON.stringify(source.sourceId)}]`);
      const panel = await waitUntil(() => observeClaudeContextInspector(harness), panel => panel.sourceId === source.sourceId && panel.sourceVisible);
      if (receipt) {
        await harness.click(`${INPUT_PANEL} [data-testid="chat-input-delivery"] > summary`);
        assertClaudeContextInspector(await observeClaudeContextInspector(harness), thread, source, receipt, text);
      } else {
        assert.equal(panel.threadId, thread.id);
        assert.equal(panel.sourceText, text);
        assert.equal(panel.packetId, undefined, 'Stored source is not a delivered Main input');
        assert.equal(panel.payloadVisible, false);
      }
      await capture(label);
      await harness.click(`${INPUT_PANEL} [aria-label="첨부 패널 닫기"]`);
      await closeActivity(harness);
    };
    await inspectHistory('claude-context-original-and-synthetic-packet');
    check('actual input-history inspector shows the original source and exact synthetic payload as separate records', true);
    await readFixture();
    await loopbackJson('/__qa/context-release', { method: 'POST', token, body: { runId: contextRun.runId, phase: 'complete' } });
    await waitUi(ui => ui.runs.find(run => run.runId === contextRun.runId)?.status === 'completed', 'Context completion');
    await newClaude('context-away');
    const beforeContextResume = await readFixture();
    await selectQaThread(harness, contextThread);
    await waitUntil(readFixture, state => state.observed.resumes.length === beforeContextResume.observed.resumes.length + 1);
    const restored = await waitUi(ui => ui.thread.id === contextThread.id && !ui.thread.resuming, 'Context room restore');
    assert.equal(restored.thread.engineId, 'claude');
    assert.equal(restored.thread.engineProfileId, contextThread.engineProfileId);
    assert.equal(restored.thread.conversationId, contextRun.conversationId);
    assert.deepEqual(restored.runs.find(run => run.runId === contextRun.runId)?.contextCaptures, [captured]);
    await inspectHistory('claude-context-restored-original');
    const contextRestored = await readFixture();
    assert.deepEqual(contextRestored.observed.captures, beforeContextResume.observed.captures);
    assert.deepEqual(contextRestored.context.deliveries, beforeContextResume.context.deliveries);
    assert.deepEqual(observeQaFixtureFile(options.profile, sourceFile), changedFile);
    check('room restore keeps Claude and the same immutable capture/receipt without recapture; not full-process restart proof', true);

    let b3 = null;
    if (readerEnabled) {
      const thread = await newClaude('large-reader');
      await attach(thread, scene[1], largeFile);
      const descriptor = await readerDescriptor(thread, true);
      const before = await readFixture(), run = await send(thread, 'CONTEXT', 'bounded-synthetic-reader');
      const bound = await readFixture();
      const source = assertClaudeContextCapture(before, bound, thread, run, largeFile, largeOriginal, { reader: true });
      assert.equal(bound.observed.sends.at(-1).expectedContextScope, descriptor.expectedContextScope);
      const largeBefore = observeQaFixtureFile(options.profile, largeFile);
      assert.equal(largeBefore.sha256, source.hash);
      const fd = fs.openSync(largeFile, fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW);
      try { fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, largeChanged); } finally { fs.closeSync(fd); }
      const largeAfter = observeQaFixtureFile(options.profile, largeFile);
      assert.equal(largeAfter.sha256, fingerprintQaBytes(largeChanged).sha256);
      const firstPage = largeOriginal.split('\n').slice(0, 200).join('\n');
      await inspectHistory('claude-reader-capture-not-main-input', { thread, run, captured: source, delivery: null, text: firstPage });
      check('B3 actual selected large source is stored without claiming Reader processing or Main receipt', true);

      const readerThreadIds = (await observeClaudeUi(harness)).threadIds;
      let reviewed = 0, total, sessionId, lastDelivery;
      do {
        await contextControl(run.runId, 'read');
        const started = await readFixture(), event = started.observed.events.at(-1);
        assert.equal(event.event, 'reader.started');
        assert.equal(event.runId, run.runId);
        assert.equal(event.details.sourceId, source.sourceId);
        total ||= event.details.totalPartitions;
        sessionId ||= event.details.readerSessionId;
        assert.ok(total > 1 && total <= 8, 'This bounded synthetic fixture must have 2–8 partitions');
        assert.equal(event.details.totalPartitions, total);
        assert.equal(event.details.readerSessionId, sessionId);
        assert.equal(event.details.nextPartition, reviewed);
        await openActivity(harness);
        const progressUi = await waitUi(ui => ui.contextActivities.some(row => row.sourceId === source.sourceId && row.event === 'reader.started'), 'visible internal Reader progress');
        assert.deepEqual(progressUi.threadIds, readerThreadIds, 'Internal Reader must not create a persona or Chat room');
        assert.equal(started.runs.length, bound.runs.length, 'No internal Reader Chat/card or subagent');
        assert.deepEqual(started.runs.find(row => row.runId === run.runId).subAgents, []);
        if (!reviewed) await capture('claude-reader-progress-not-complete');
        await contextControl(run.runId, 'reader-processed');
        const processed = await readFixture();
        assertClaudeReaderProcessed(started, processed, run, source, largeOriginal, reviewed + 1);
        await contextControl(run.runId, 'reader-deliver');
        const delivered = await readFixture();
        assert.equal(delivered.context.deliveries.length, before.context.deliveries.length + reviewed + 1);
        lastDelivery = delivered.context.deliveries.at(-1);
        reviewed++;
        assertClaudeReaderPacket(lastDelivery, source, run, largeOriginal, { reviewed, total, sessionId });
        await waitUi(ui => ui.runs.find(row => row.runId === run.runId)?.contextEvents?.filter(row => row.event === 'context.read.completed').length === reviewed,
          'Reader receipt reflected in the selected room');
        assert.equal(delivered.runs.find(row => row.runId === run.runId).status, 'inProgress');
        if (reviewed < total) {
          await assert.rejects(contextControl(run.runId, 'complete'));
          await inspectHistory(claudeReaderPartialCaptureLabel(reviewed, total), { thread, run, captured: source, delivery: lastDelivery, text: firstPage });
        }
      } while (reviewed < total);
      check('internal Reader progress is visible; bounded continuation keeps one session and cannot claim whole-source completion early', true);
      check('each Reader partition retains exact original bytes while prepared and Main-received boundaries stay separate', true);
      await inspectHistory('claude-reader-exact-source-and-structured-summary', { thread, run, captured: source, delivery: lastDelivery, text: firstPage });
      check('actual inspector separates captured old source from exact synthetic structured summary and source quote spans', true);
      await contextControl(run.runId, 'complete');
      await waitUi(ui => ui.runs.find(row => row.runId === run.runId)?.status === 'completed', 'synthetic Reader parent completion');
      await newClaude('large-reader-away');
      const beforeResume = await readFixture();
      await selectQaThread(harness, thread);
      await waitUntil(readFixture, state => state.observed.resumes.length === beforeResume.observed.resumes.length + 1);
      const ui = await waitUi(ui => ui.thread.id === thread.id && !ui.thread.resuming, 'large Reader room restore');
      assert.deepEqual(ui.runs.find(row => row.runId === run.runId)?.contextCaptures, [source]);
      assert.equal(ui.thread.engineId, 'claude');
      await inspectHistory('claude-reader-restored-old-source', { thread, run, captured: source, delivery: lastDelivery, text: firstPage });
      const resumed = await readFixture();
      assert.deepEqual(resumed.context.readerProcessed, beforeResume.context.readerProcessed);
      assert.deepEqual(resumed.context.deliveries, beforeResume.context.deliveries);
      assert.deepEqual(resumed.observed.captures, beforeResume.observed.captures);
      assert.deepEqual(observeQaFixtureFile(options.profile, largeFile), largeAfter);
      check('large-source room resume retains the old source and exact synthetic summary without reread/recapture after live mutation', true);
      b3 = { sourceFile: largeFile, captured: source, changedFile: largeAfter, syntheticDelivery: lastDelivery,
        partitions: total, actualModelReadVerified: false, adapterExecutionVerified: false, aggregateBudgetVerified: false };

      for (const outcome of ['failure', 'cancel']) {
        const thread = await newClaude(`reader-${outcome}`);
        await attach(thread, scene[1], largeFile);
        await readerDescriptor(thread, true);
        const before = await readFixture(), run = await send(thread, 'CONTEXT', `reader-${outcome}`);
        const source = assertClaudeContextCapture(before, await readFixture(), thread, run, largeFile, largeChanged, { reader: true });
        await contextControl(run.runId, 'read');
        await openActivity(harness);
        await waitUi(ui => ui.contextActivities.some(row => row.sourceId === source.sourceId && row.event === 'reader.started'), 'Reader pending before failure/cancel');
        await contextControl(run.runId, 'reader-processed'); // Prepared output must still be discarded.
        const beforeEnd = await readFixture();
        if (outcome === 'failure') await contextControl(run.runId, 'reader-fail');
        else {
          await closeActivity(harness);
          await harness.click('[data-testid="chat-stop"]');
          const stopping = await waitUntil(readFixture, state => state.runs.find(row => row.runId === run.runId)?.stopRequested);
          assert.equal(stopping.runs.find(row => row.runId === run.runId).status, 'inProgress', 'Stop ACK is not completion');
          assert.equal(stopping.observed.interrupts.length, beforeEnd.observed.interrupts.length + 1);
          await control(run.runId, 'run');
        }
        const status = outcome === 'failure' ? 'failed' : 'interrupted';
        const endedUi = await waitUi(ui => ui.runs.find(row => row.runId === run.runId)?.status === status, `visible Reader ${status}`);
        assert.deepEqual(endedUi.runs.find(row => row.runId === run.runId).contextCaptures, [source]);
        await assert.rejects(contextControl(run.runId, 'reader-deliver'));
        await assert.rejects(contextControl(run.runId, 'complete'));
        const ended = await readFixture();
        assertClaudeReaderEnded(beforeEnd, ended, run, source, status);
        await openActivity(harness);
        await waitUi(ui => ui.contextActivities.some(row => row.sourceId === source.sourceId && row.event === 'reader.failed'
          && row.text.includes(outcome === 'failure' ? '다시 시도' : '중단')), 'visible Reader required-action failure');
        await inspectHistory(`claude-reader-${outcome}-source-retained`, { thread, run, captured: source, delivery: null,
          text: largeChanged.split('\n').slice(0, 200).join('\n') });
        assertNoAutomaticRequests(await readFixture(), await readFixture());
        check(`Reader ${outcome} keeps accepted source history, discards prepared output and never auto-completes or falls back`, true);
      }
      // Unknown capacity is not a guessed model-window success. Keep the
      // negative before the unavailable-reader and missing-B2 negatives.
      await loopbackJson('/__qa/context-config', { method: 'POST', token, body: { claudeCapacityKnown: false } });
      const capacityThread = await newClaude('reader-capacity-unknown');
      await attach(capacityThread, scene[1], largeFile);
      const unavailable = await readerDescriptor(capacityThread, false);
      assert.equal(unavailable.reader.code, 'ENGINE_CAPACITY_UNKNOWN');
      const prompt = `EGDESK_QA_CLAUDE_CONTEXT ${nonce} capacity-unknown`;
      await replaceComposerText(harness, prompt);
      const beforeUi = await observeClaudeUi(harness), beforeFixture = await readFixture();
      await sendFromComposer(harness, prompt);
      const rejected = await waitUi(ui => !!ui.thread.sendError, 'capacity unknown is a visible actionable error');
      assert.ok(rejected.thread.sendError.includes('용량') && rejected.thread.sendError.includes('초안'));
      assertClaudeReaderBlocked(beforeUi, rejected, beforeFixture, await readFixture(), { message: rejected.thread.sendError, code: 'ENGINE_CAPACITY_UNKNOWN' });
      check('unknown capacity is an explicit visible server error with draft/source retained and no guessed Reader run', true);
      await capture('claude-reader-capacity-unknown-draft-retained');
      await loopbackJson('/__qa/context-config', { method: 'POST', token, body: { claudeCapacityKnown: true, claudeReader: false } });
    }

    const largeThread = await newClaude('context-reader-blocked');
    await readerDescriptor(largeThread, false);
    await attach(largeThread, scene[1], largeFile);
    const largePrompt = `EGDESK_QA_CLAUDE_CONTEXT ${nonce} reader-must-block`;
    await replaceComposerText(harness, largePrompt);
    const beforeLarge = await observeClaudeUi(harness), beforeLargeFixture = await readFixture();
    await sendFromComposer(harness, largePrompt);
    const largeBlocked = await waitUi(ui => ui.thread.sendError === CLAUDE_READER_ERROR, 'exact Claude Smart Read refusal');
    const largeRefused = await readFixture();
    assertClaudeReaderBlocked(beforeLarge, largeBlocked, beforeLargeFixture, largeRefused);
    await capture('claude-context-reader-blocked-draft-retained');
    assertNoAutomaticRequests(largeRefused, await readFixture());
    check('large complete source is explicitly refused without Reader/Codex fallback, truncation, send acceptance or draft/attachment loss', true);

    // Retain the original unsupported-server negative as a separate contract:
    // no verified B2 descriptor means no capture or send, even for small text.
    await loopbackJson('/__qa/context-config', { method: 'POST', token, body: { claudeCapabilities: false } });
    const unsupportedThread = await newClaude('context-unavailable');
    await attach(unsupportedThread, scene[0], sourceFile);
    const unsupportedPrompt = `EGDESK_QA_CLAUDE_CONTEXT_BLOCKED ${nonce}`;
    await replaceComposerText(harness, unsupportedPrompt);
    const beforeUnavailable = await observeClaudeUi(harness), beforeUnavailableFixture = await readFixture();
    await sendFromComposer(harness, unsupportedPrompt);
    const unavailable = await waitUi(ui => ui.thread.sendError === CLAUDE_CONTEXT_ERROR, 'missing Context descriptor refusal');
    assertClaudeContextBlocked(beforeUnavailable, unavailable, beforeUnavailableFixture, await readFixture());
    check('missing B2 descriptor still blocks before capture/send and preserves draft plus attachment', true);
    await capture('claude-context-unavailable-draft-retained');
    if (readerEnabled) {
      await loopbackJson('/__qa/context-config', { method: 'POST', token,
        body: { claudeCapabilities: true, claudeReader: true } });
      const thread = await newClaude('reader-late-account');
      await attach(thread, scene[1], largeFile);
      const descriptor = await readerDescriptor(thread, true);
      const before = await readFixture(), run = await send(thread, 'CONTEXT', 'reader-account-epoch');
      const source = assertClaudeContextCapture(before, await readFixture(), thread, run, largeFile, largeChanged, { reader: true });
      await contextControl(run.runId, 'read');
      await contextControl(run.runId, 'reader-processed');
      // A Codex-only account notification must not invalidate Claude work.
      await loopbackJson('/__qa/account-change', { method: 'POST', token, body: { variant: 'b' } });
      assert.equal((await readerDescriptor(thread, true)).expectedContextScope, descriptor.expectedContextScope);
      const beforeAccountUi = await observeClaudeUi(harness);
      await loopbackJson('/__qa/account-change', { method: 'POST', token, body: { engineId: 'claude', variant: 'b' } });
      const changedUi = await waitUi(ui => ui.thread?.sendError?.includes('계정이 바뀌었습니다'), 'visible Claude account invalidation');
      assert.equal(changedUi.composer, beforeAccountUi.composer);
      assert.equal(changedUi.thread.draft, beforeAccountUi.thread.draft);
      assert.deepEqual(changedUi.thread.inputSources, beforeAccountUi.thread.inputSources);
      assert.ok(changedUi.alerts.some(text => text.includes('계정이 바뀌었습니다')));
      const beforeLate = await readFixture();
      for (const phase of ['reader-deliver', 'complete']) await assert.rejects(contextControl(run.runId, phase), /ACCOUNT_CHANGED/);
      await assert.rejects(loopbackJson(`/context/captures/${source.sourceId}?${new URLSearchParams({ engineId: 'claude',
        engineProfileId: thread.engineProfileId, clientThreadId: thread.wireClientThreadId })}`), /CONTEXT_NOT_FOUND/);
      const afterLate = await readFixture();
      assert.deepEqual(afterLate.observed.contextRefusals, [...beforeLate.observed.contextRefusals,
        { route: `/context/captures/${source.sourceId}`, code: 'CONTEXT_NOT_FOUND' }]);
      assertNoAutomaticRequests({ ...beforeLate, observed: { ...beforeLate.observed,
        contextRefusals: afterLate.observed.contextRefusals } }, afterLate);
      assert.deepEqual(afterLate.observed.events, beforeLate.observed.events);
      assert.equal(afterLate.runs.find(row => row.runId === run.runId).status, 'inProgress', 'An invalidated operation is not a confirmed completion');
      check('only the selected engine account epoch blocks late Reader delivery/completion; visible draft state is retained without fallback', true);
      await capture('claude-reader-late-account-rejected');
      b3.accountInvalidation = { sourceId: source.sourceId, runId: run.runId, lateDeliveryAccepted: false, completionConfirmed: false };
    }
    assertClaudeReady(await loopbackJson('/v1/state'));
    const final = await readFixture();
    assert.equal(final.observed.authWrites.length, 0);
    assert.equal(final.observed.blockedContexts.length, 0, 'UI must refuse before backend Context safety fallback');
    assert.equal(final.context.captureBatches, readerEnabled ? 7 : 2);
    assert.equal(final.context.deliveries.length, readerEnabled ? 1 + b3.partitions : 1);
    assert.deepEqual(CLAUDE_CONTEXT_TOOLS, ['egdesk_list_context', 'egdesk_read_source']);
    assert.ok(final.observed.events.every(event => event.event !== 'briefing.published'
      && (readerEnabled || !['reader.started', 'reader.completed'].includes(event.event))));
    result.contextFixture = { sourceFile, changedFile, captured, syntheticDelivery: delivery,
      actualModelReadVerified: false, restartVerified: false };
    result.readerFixture = b3;
    result.fixtureRequests = { sends: final.observed.sends.length, resumes: final.observed.resumes.length,
      approvals: final.observed.approvals.length, userInputs: final.observed.userInputs.length,
      captureBatches: final.context.captureBatches, syntheticDeliveries: final.context.deliveries.length };
    check(readerEnabled ? 'Codex remains signed out; provider0/authWrites0; all Reader receipts synthetic, no real adapter/browser/computer execution'
      : 'Codex remains signed out; provider0, authWrites0, no browser/plan/computer/Reader execution', true);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runClaudeFixtureFlow(claudeFixtureOptions(process.argv.slice(2))); }
  catch (error) {
    process.stderr.write(`Claude fixture preflight: ${error.message}\n`);
    process.exitCode = 1;
  }
}
