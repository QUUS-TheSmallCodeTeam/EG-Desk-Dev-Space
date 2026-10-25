#!/usr/bin/env node
// Attach-only acceptance plan. Main owns browser/listener/SSE mounting and
// visual review. No DOM/state injection, direct continue POST or fake receipt.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chrome, loopbackJson, openChat, replaceFieldText, runUiFlow, sendFromComposer, waitUntil } from './egdesk-qa-ui-flow.mjs';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { parseCli, assertBeforeDeadline, observeGuard, waitFor } from './verify-firefox-mcp-headless-ui-regression.mjs';
import { prepareRunOutputDesk } from './verify-firefox-mcp-chat-run-outputs-flow.mjs';
import { taskGateFixtureEnabled, TASK_GATE_SEED_MESSAGE, TASK_GATE_STATE_ROUTE, TASK_GATE_CONTROL_ROUTE } from './egdesk-task-gate-fixture.mjs';

// Proposed Harvey contract; no production selectors are added by this file.
// Rows carry exact IDs/key as metadata, never as human-facing text. Choice is
// a native radio input; labels/questions/status use textContent, text is a
// textarea. Continue is type=button, never an implicit form/Enter submission.
// The existing chat-task-list is keyboard-focusable for native scroll keys.
export const TASK_GATE_SELECTORS = Object.freeze({ row: 'chat-task-condition', choice: 'chat-task-answer-choice',
  text: 'chat-task-answer-text', limit: 'chat-task-answer-limit', continue: 'chat-task-answer-continue',
  cancel: 'chat-task-answer-cancel', notice: 'chat-task-error', question: 'chat-task-question', next: 'chat-task-answer-next' });
const testid = value => `[data-testid=${JSON.stringify(value)}]`;
const hash = value => createHash('sha256').update(value).digest('hex');
const normalized = value => value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
const posts = state => state.requests.filter(row => row.method === 'POST' && row.path === '/tasks/continue');

export function taskGateRowSelector(identity) {
  for (const key of ['graphId', 'taskId', 'gateId']) assert.ok(typeof identity?.[key] === 'string' && identity[key].length > 0 && identity[key].length <= 256);
  return `${testid(TASK_GATE_SELECTORS.row)}[data-graph-id=${JSON.stringify(identity.graphId)}][data-task-id=${JSON.stringify(identity.taskId)}][data-gate-id=${JSON.stringify(identity.gateId)}]`;
}
export function assertTaskGateEnvironment(env) {
  assert.equal(taskGateFixtureEnabled(env), true);
  assert.ok(typeof env.EGDESK_QA_FIXTURE_TOKEN === 'string' && env.EGDESK_QA_FIXTURE_TOKEN.length >= 16);
  const port = env.EGDESK_QA_FIXTURE_PORT;
  assert.ok(typeof port === 'string' && /^[1-9][0-9]{0,4}$/.test(port) && Number(port) <= 65535 && Number(port) !== 39218);
  return true;
}

export function assertQuestionIdentity(ui, identity, threadId) {
  assert.equal(ui?.count, 1, 'one exact condition row, not the first visible gate');
  assert.equal(ui.threadId, threadId, 'still in the original local room');
  for (const key of ['graphId', 'taskId', 'gateId']) assert.equal(ui[key], identity[key]);
  assert.ok(typeof ui.responseKey === 'string' && ui.responseKey.length > 0);
  assert.deepEqual(JSON.parse(ui.responseKey), ['userAction', identity.label, identity.response], 'descriptor matches the exact backend question');
  assert.equal(ui.question, identity.label);
  assert.ok(ui.next.trim().length > 0, 'the person can read what continues');
  for (const value of [ui.question, ui.next]) assert.equal(/\b(?:graphId|gateId|responseKey)\b/.test(value), false);
  return true;
}
export function assertNoContinue(before, after, label) {
  assert.deepEqual(posts(after), posts(before), `${label}: no continue POST, not merely no successful answer`);
  assert.deepEqual(after.persisted.answers, before.persisted.answers, `${label}: no written answer stored`);
  assert.equal(after.fakeProviderTurns.length, before.fakeProviderTurns.length, `${label}: no resumed provider turn`);
  return true;
}
export function assertDraftRetained(before, after, { notice = false } = {}) {
  for (const key of ['threadId', 'graphId', 'taskId', 'gateId', 'responseKey', 'value', 'choice']) assert.equal(after[key], before[key], `same-question ${key}`);
  if (notice) { assert.ok(before.notice.trim()); assert.equal(after.notice, before.notice); }
  return true;
}
export function assertNewQuestionCleared(before, after) {
  assert.ok(before.graphId !== after.graphId || before.gateId !== after.gateId || before.responseKey !== after.responseKey, 'question identity really changed');
  assert.equal(after.value, ''); assert.equal(after.choice, null); assert.equal(after.notice, '');
  return true;
}
export function assertCodePointLimit(ui, raw, limit, { invalid = false } = {}) {
  assert.equal(ui.value, raw, 'native text was not silently clipped/normalized');
  assert.equal(ui.limit, limit, 'limit comes from the rendered descriptor, not a guessed number');
  assert.equal(ui.counted, Array.from(normalized(raw)).length, 'display uses normalized code points, not UTF-16 units');
  assert.ok(ui.limitText.includes(String(limit)), 'limit is readable');
  if (invalid) assert.ok(ui.continueDisabled || ui.notice.trim(), 'oversize input has a visible block or explanation');
  return true;
}
export function assertOneAnswer(before, after, identity, status = 200) {
  const old = posts(before), next = posts(after);
  assert.equal(next.length, old.length + 1, 'one explicit Continue produces one POST');
  const row = next.at(-1);
  assert.equal(row.delegated, true, 'production Task handler produced the response'); assert.equal(row.status, status);
  for (const key of ['graphId', 'taskId', 'gateId']) assert.equal(row.request[key], identity[key]);
  return row;
}
export function assertTaskGateEvidence(evidence) {
  assert.equal(evidence?.nativeInputs, true); assert.equal(evidence.domInjection, false);
  assert.equal(evidence.fixture.providerTurns, 0); assert.equal(evidence.fixture.nativeProcessSpawns, 0);
  const original = evidence.fixture.original;
  assert.equal(original.conversationId, evidence.conversationId);
  assert.equal(original.clientThreadId, evidence.clientThreadId);
  assert.ok(evidence.threadId);
  assert.ok(evidence.fixture.fakeProviderTurns.length >= 3);
  assert.ok(evidence.fixture.fakeProviderTurns.every(turn => turn.conversationId === original.conversationId));
  for (const proof of [evidence.choice, evidence.rejected, evidence.text, evidence.stale]) {
    const plan = evidence.fixture.plans.find(value => value.graphId === proof.identity.graphId);
    assert.ok(plan?.questions.some(value => value.taskId === proof.identity.taskId && value.gateId === proof.identity.gateId));
    assert.equal(plan.origin.conversationId, original.conversationId);
    assert.ok(evidence.fixture.frames.some(frame => frame.type === 'task.graph' && frame.graphId === plan.graphId));
  }
  for (const [ui, identity] of [[evidence.rejected.typed, evidence.rejected.identity], [evidence.rejected.ui, evidence.rejected.identity],
    [evidence.text.ui, evidence.text.identity], [evidence.stale.typed, evidence.stale.identity], [evidence.stale.ui, evidence.stale.identity]]) {
    assertQuestionIdentity(ui, identity, evidence.threadId);
  }
  for (const stage of ['choice-select', 'choice-enter', 'choice-cancel', 'typing', 'text-enter', 'oversize', 'same-question-refresh']) {
    const proof = evidence.noPosts.find(item => item.stage === stage); assert.ok(proof, stage);
    assertNoContinue(proof.before, proof.after, stage);
  }
  assertOneAnswer(evidence.choice.before, evidence.choice.after, evidence.choice.identity);
  assertQuestionIdentity(evidence.choice.ui, evidence.choice.identity, evidence.threadId);
  assert.equal(evidence.choice.ui.choice, 'kakao');
  assert.equal(posts(evidence.choice.after).at(-1).request.answer.choice, evidence.choice.ui.choice);
  assertOneAnswer(evidence.rejected.before, evidence.rejected.after, evidence.rejected.identity, 400);
  assert.equal(posts(evidence.rejected.after).at(-1).response.code, 'TASK_GATE_ANSWER_PRIVATE');
  assertDraftRetained(evidence.rejected.typed, evidence.rejected.ui);
  assertDraftRetained(evidence.rejected.ui, evidence.rejected.refreshed, { notice: true });
  assertOneAnswer(evidence.text.before, evidence.text.after, evidence.text.identity);
  assertCodePointLimit(evidence.text.ui, evidence.text.value, 20);
  assert.ok(evidence.text.after.persisted.answers.some(row => row.graphId === evidence.text.identity.graphId
    && row.taskId === evidence.text.identity.taskId && row.gateId === evidence.text.identity.gateId
    && row.textSha256 === hash(normalized(evidence.text.value)) && row.codePoints === 20));
  assertNewQuestionCleared(evidence.previousQuestion, evidence.newQuestion);
  assertOneAnswer(evidence.stale.before, evidence.stale.after, evidence.stale.identity, 409);
  assert.equal(posts(evidence.stale.after).at(-1).response.code, 'TASK_GATE_STALE');
  assertDraftRetained(evidence.stale.typed, evidence.stale.ui);
  assert.ok(evidence.stale.ui.notice.trim());
  assert.ok(Number.isSafeInteger(evidence.duplicate.whileHeld.held?.sequence), 'actual held POST exists');
  assert.equal(evidence.duplicate.whileHeld.held.sequence, evidence.duplicate.afterAttempt.held?.sequence);
  assert.equal(posts(evidence.duplicate.whileHeld).length, posts(evidence.duplicate.afterAttempt).length);
  assert.equal(evidence.duplicate.disabled, true);
  return true;
}

// Browser evaluation below is observation only. Input uses MCP native tools.
export async function observeTaskGate(harness, identity) {
  const selector = taskGateRowSelector(identity);
  return chrome(harness, ({ selector, names }) => {
    const matches = [...document.querySelectorAll(selector)], row = matches.length === 1 ? matches[0] : null;
    const one = key => row?.querySelector(`[data-testid="${names[key]}"]`);
    const input = one('text'), button = one('continue'), checked = row?.querySelector(`[data-testid="${names.choice}"]:checked`);
    return { count: matches.length, threadId: window.__egdesk?.state?.codex?.activeThreadId || null,
      graphId: row?.dataset.graphId, taskId: row?.dataset.taskId, gateId: row?.dataset.gateId,
      responseKey: row?.dataset.responseKey, state: row?.dataset.state,
      question: one('question')?.textContent || '', next: one('next')?.textContent || '',
      value: input?.value ?? '', choice: checked?.dataset.choiceId ?? null,
      choiceCount: row?.querySelectorAll(`[data-testid="${names.choice}"]`).length || 0,
      choiceTypes: [...(row?.querySelectorAll(`[data-testid="${names.choice}"]`) || [])].map(node => node.type),
      limit: one('limit') ? Number(one('limit').dataset.maxLength) : null,
      counted: one('limit') ? Number(one('limit').dataset.codePoints) : null,
      limitText: one('limit')?.textContent || '', notice: one('notice')?.textContent || '',
      continueDisabled: !button || button.disabled === true || button.getAttribute('aria-disabled') === 'true' };
  }, { selector, names: TASK_GATE_SELECTORS });
}
async function observeTarget(harness, selector) {
  return chrome(harness, selector => {
    const nodes = [...document.querySelectorAll(selector)], node = nodes.length === 1 ? nodes[0] : null;
    const r = node?.getBoundingClientRect(), css = node && getComputedStyle(node); let hits = 0, clipped = false;
    if (r) {
      for (const x of [.2, .5, .8]) for (const y of [.2, .5, .8]) { const hit = document.elementFromPoint(r.left + r.width * x, r.top + r.height * y); if (hit === node || node.contains(hit)) hits++; }
      for (let parent = node.parentElement; parent; parent = parent.parentElement) {
        const p = parent.getBoundingClientRect(), s = getComputedStyle(parent);
        if (/(auto|scroll|hidden|clip)/.test(s.overflowY) && (r.top < p.top || r.bottom > p.bottom)
          || /(auto|scroll|hidden|clip)/.test(s.overflowX) && (r.left < p.left || r.right > p.right)) clipped = true;
      }
    }
    const list = node?.closest('[data-testid="chat-task-list"]'), listBox = list?.getBoundingClientRect();
    return { count: nodes.length, visible: !!r && r.width > 0 && r.height > 0 && css.display !== 'none' && css.visibility !== 'hidden',
      inside: !!r && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      hits, clipped, disabled: !node || node.disabled || node.getAttribute('aria-disabled') === 'true',
      scrollDirection: listBox && r ? r.bottom > listBox.bottom ? 'PageDown' : r.top < listBox.top ? 'PageUp' : null : null };
  }, selector);
}

// Only the first-use fields needed by the established native Desk exit. A
// missing Browser/fullscreen is not a matching fullscreen (undefined === undefined).
// Keep this read local; no shared observer or product state is changed.
export async function observeTaskGateDesk(harness) {
  return chrome(harness, () => {
    const api = window.__egdesk;
    const surface = api.surface.snapshot();
    const card = surface.browserCardId ? document.getElementById(surface.browserCardId) : null;
    const fullscreen = api.state.cardFullscreen;
    return { initialBrowserFocus: surface.initialBrowserFocus === true,
      fullscreen: !!card?.id && !!fullscreen && fullscreen.cardId === card.id,
      cardId: card?.id || null, browserContextId: card?._xulBrowser?.browsingContext?.id ?? null };
  });
}

export async function runTaskGateFlow({ harness, result, check, capture, defer }, { profile, deadlineMs, env = process.env }) {
  assertTaskGateEnvironment(env); assertQaFixtureManifest(profile); assertBeforeDeadline(deadlineMs);
  const guard = await observeGuard(harness);
  assert.ok(guard.headless && guard.mounted && guard.loggedIn && guard.accountBound, 'owned connected headless surface required');
  const token = env.EGDESK_QA_FIXTURE_TOKEN;
  const state = () => { assertBeforeDeadline(deadlineMs); return loopbackJson(TASK_GATE_STATE_ROUTE, { token, env }); };
  const control = action => { assertBeforeDeadline(deadlineMs); return loopbackJson(TASK_GATE_CONTROL_ROUTE, { method: 'POST', body: { action }, token, env }); };
  const waitState = accept => waitFor(harness, state, accept, deadlineMs);
  const read = identity => observeTaskGate(harness, identity);
  const field = (identity, name) => `${taskGateRowSelector(identity)} ${testid(TASK_GATE_SELECTORS[name])}`;
  const ready = async selector => {
    assertBeforeDeadline(deadlineMs);
    for (let i = 0; i < 6; i++) {
      const target = await waitFor(harness, () => observeTarget(harness, selector), value => value.count === 1 && value.visible, deadlineMs);
      if (target.inside && !target.clipped && target.hits === 9 && !target.disabled) return;
      if (!target.scrollDirection) break;
      assertBeforeDeadline(deadlineMs);
      await harness.scrollWithKey('[data-testid="chat-task-list"]', target.scrollDirection);
    }
    await waitFor(harness, () => observeTarget(harness, selector), value => value.count === 1 && value.visible && value.inside && !value.clipped && value.hits === 9 && !value.disabled, deadlineMs);
  };
  const click = async selector => {
    await ready(selector);
    assertBeforeDeadline(deadlineMs);
    await harness.click(selector);
  };
  const press = (key, selector) => { assertBeforeDeadline(deadlineMs); return harness.press(key, selector); };
  const type = async (identity, value) => { await ready(field(identity, 'text')); await replaceFieldText(harness, field(identity, 'text'), value); };
  const refresh = async identity => {
    const reads = value => value.requests.filter(row => row.path === '/tasks/state' && row.query.includes(identity.graphId) && row.status === 200).length;
    const before = reads(await state());
    await control('replay'); await waitState(value => value.frames.some(frame => frame.type === 'task.native')); await control('refresh');
    await waitState(value => reads(value) > before);
  };
  const evidence = { nativeInputs: true, domInjection: false, noPosts: [] };
  result.taskGate = evidence;
  // Best effort releases only fixture-owned holds, never a user process.
  defer(async () => {
    const current = await loopbackJson(TASK_GATE_STATE_ROUTE, { token, env });
    if (current.held) await loopbackJson(TASK_GATE_CONTROL_ROUTE, { method: 'POST', body: { action: 'release' }, token, env });
    if (current.pauseBroadcast) await loopbackJson(TASK_GATE_CONTROL_ROUTE, { method: 'POST', body: { action: 'flush' }, token, env });
  });
  assert.equal((await state()).original, null, 'fresh task fixture, not an earlier UI run');
  result.initialDesk = await prepareRunOutputDesk(harness, { deadlineMs, readFirstUse: observeTaskGateDesk, waitUntil });
  check('Native first-use exit exposes the Chat Dock without replacing the Browser', true, result.initialDesk);
  assertBeforeDeadline(deadlineMs);
  await openChat(harness);
  if ((await harness.inspect('.egd-codex-conversation-back')).some(node => node.visible)) await click('.egd-codex-conversation-back');
  await click('.egd-codex-thread-home-new');
  const local = await chrome(harness, () => {
    const c = window.__egdesk.state.codex, t = c.threads.find(value => value.id === c.activeThreadId);
    return { id: t?.id, clientThreadId: t?.clientBindingId || t?.id, conversationId: t?.conversationId,
      messages: t?.messages?.length, profileEnabled: t?.profileEnabled };
  });
  assert.ok(local.id && !local.conversationId && local.messages === 0 && local.profileEnabled !== true);
  assertBeforeDeadline(deadlineMs);
  await sendFromComposer(harness, TASK_GATE_SEED_MESSAGE);
  let fixture = await waitState(value => value.plans.length === 1 && value.original);
  evidence.conversationId = fixture.original.conversationId;
  evidence.threadId = local.id; evidence.clientThreadId = local.clientThreadId;
  assert.equal(fixture.original.clientThreadId, local.clientThreadId);
  const identify = (plan, question) => ({ graphId: plan.graphId, ...question });
  const choice = identify(fixture.plans[0], fixture.plans[0].questions.find(value => value.taskId === 'send'));
  const text = identify(fixture.plans[0], fixture.plans[0].questions.find(value => value.taskId === 'note'));
  const summary = '[data-testid="chat-task-summary"]';
  const expanded = await chrome(harness, selector => document.querySelector(selector)?.getAttribute('aria-expanded'), summary);
  if (expanded !== 'true') await click(summary);
  const initialChoice = await waitFor(harness, () => read(choice), value => value.count === 1 && value.choiceCount === 2, deadlineMs);
  assertQuestionIdentity(initialChoice, choice, local.id); assert.ok(initialChoice.choiceTypes.every(value => value === 'radio'));
  const choose = id => click(`${field(choice, 'choice')}[data-choice-id=${JSON.stringify(id)}]`);
  const withoutPost = async (stage, action) => { const before = await state(); await action(); const after = await state();
    assertNoContinue(before, after, stage); evidence.noPosts.push({ stage, before, after }); };
  await withoutPost('choice-select', () => choose('email'));
  await withoutPost('choice-enter', () => press('Enter', `${field(choice, 'choice')}[data-choice-id="email"]`));
  await withoutPost('choice-cancel', () => click(field(choice, 'cancel')));
  assert.equal((await read(choice)).choice, null, 'cancel clears only the local choice');
  await choose('kakao');
  const selectedChoice = await read(choice);
  const choiceBefore = await state(); await control('hold-next'); await click(field(choice, 'continue'));
  const whileHeld = await waitState(value => value.held !== null), busy = await read(choice);
  assert.equal(busy.continueDisabled, true);
  // A second native click at the actual disabled control must not dispatch.
  // Do not use ready(), which intentionally refuses disabled targets.
  assertBeforeDeadline(deadlineMs);
  await harness.click(field(choice, 'continue'));
  const afterAttempt = await state();
  evidence.duplicate = { whileHeld, afterAttempt, disabled: busy.continueDisabled };
  await control('release');
  const choiceAfter = await waitState(value => posts(value).at(-1)?.status === 200 && value.fakeProviderTurns.length === 2);
  evidence.choice = { identity: choice, before: choiceBefore, after: choiceAfter, ui: selectedChoice };
  assertOneAnswer(choiceBefore, choiceAfter, choice);
  await control('complete-turn');
  await waitFor(harness, () => read(text), value => value.count === 1 && value.limit === 20, deadlineMs);
  assertQuestionIdentity(await read(text), text, local.id);
  const tooLong = '😀'.repeat(21);
  await withoutPost('typing', () => type(text, tooLong));
  await ready(field(text, 'limit'));
  const over = await read(text); assertCodePointLimit(over, tooLong, 20);
  await withoutPost('oversize', async () => {
    if (over.continueDisabled) { assertBeforeDeadline(deadlineMs); await harness.click(field(text, 'continue')); }
    else await click(field(text, 'continue'));
  });
  assertCodePointLimit(await read(text), tooLong, 20, { invalid: true });
  const validText = '😀'.repeat(20);
  await type(text, validText);
  await withoutPost('text-enter', () => press('Enter', field(text, 'text')));
  const secret = 'pw: hunter2';
  await type(text, secret);
  const typed = await read(text), rejectedBefore = await state();
  await click(field(text, 'continue'));
  const rejectedAfter = await waitState(value => posts(value).at(-1)?.response?.code === 'TASK_GATE_ANSWER_PRIVATE');
  const rejectedUi = await waitFor(harness, () => read(text), value => !!value.notice, deadlineMs);
  const beforeRefresh = await state(); await refresh(text);
  const refreshed = await read(text), afterRefresh = await state();
  evidence.noPosts.push({ stage: 'same-question-refresh', before: beforeRefresh, after: afterRefresh });
  evidence.rejected = { identity: text, before: rejectedBefore, after: rejectedAfter, typed, ui: rejectedUi, refreshed };
  assertDraftRetained(rejectedUi, refreshed, { notice: true });
  // Change identity while an actual failed draft and notice are still present,
  // not after a successful answer has already cleared them.
  evidence.previousQuestion = await read(text);
  await control('next-question'); fixture = await state();
  const next = identify(fixture.plans[1], fixture.plans[1].questions[0]);
  const emptyNext = await waitFor(harness, () => read(next), value => value.count === 1 && value.limit === 8, deadlineMs);
  assertQuestionIdentity(emptyNext, next, local.id); evidence.newQuestion = emptyNext;
  assertNewQuestionCleared(evidence.previousQuestion, emptyNext);
  await type(text, validText);
  await ready(field(text, 'limit'));
  const textUi = await read(text), textBefore = await state();
  await click(field(text, 'continue'));
  const textAfter = await waitState(value => posts(value).at(-1)?.status === 200 && value.persisted.answers.length === 1 && value.fakeProviderTurns.length === 3);
  evidence.text = { identity: text, before: textBefore, after: textAfter, ui: textUi, value: validText };
  await control('complete-turn');
  await type(next, '다음 답변');
  const staleTyped = await read(next), staleBefore = await state();
  await control('hold-next'); await click(field(next, 'continue'));
  await waitState(value => value.held !== null);
  await control('accept-held'); await control('release');
  const staleAfter = await waitState(value => posts(value).at(-1)?.response?.code === 'TASK_GATE_STALE');
  const staleUi = await waitFor(harness, () => read(next), value => !!value.notice, deadlineMs);
  evidence.stale = { identity: next, before: staleBefore, after: staleAfter, typed: staleTyped, ui: staleUi };
  await control('flush');
  evidence.fixture = await state();
  assertTaskGateEvidence(evidence);
  check('Task answers used native controls, original identities and real Task HTTP/SQLite', true);
  assertBeforeDeadline(deadlineMs);
  await capture('task-gate-answer-flow');
  result.providerTurn = 'fake-provider-only';
  result.remaining = ['Main visual/native UI review', 'Real provider execution (not exercised)'];
}

export async function runCli(argv = process.argv.slice(2), env = process.env) {
  const options = parseCli(argv); assertTaskGateEnvironment(env);
  await runUiFlow('firefox-mcp-task-gate-flow', context => runTaskGateFlow(context, { ...options, env }));
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
