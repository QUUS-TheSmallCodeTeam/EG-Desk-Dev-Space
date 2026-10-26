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
  assert.ok(Number.isSafeInteger(limit) && limit > 0, 'maximum length comes from the actual question contract');
  const counted = Array.from(normalized(ui.value)).length;
  const visible = /^\s*(\d+)\s*\/\s*(\d+)\s*자(?:\s*·[^\r\n]*)?\s*$/.exec(ui.limitText);
  assert.ok(visible, 'visible count/limit text must be parseable');
  assert.equal(Number(visible[1]), counted, 'VISIBLE counter equals actual input NFC/code-point count, not only dataset');
  assert.equal(Number(visible[2]), limit, 'VISIBLE maximum equals the original question contract');
  assert.equal(ui.limit, limit, 'dataset maximum also matches the original question contract');
  assert.equal(ui.counted, counted, 'dataset count also matches normalized code points, not UTF-16 units');
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

export function reconciledTaskGateRead(state, identity, afterSequence) {
  return state.requests.findLast(row => {
    if (row.method !== 'GET' || row.path !== '/tasks/state' || row.sequence <= afterSequence
      || row.delegated !== true || row.status !== 200) return false;
    const ids = new URLSearchParams(row.query).getAll('graphId'), graph = row.response?.graph;
    const gate = graph?.tasks?.find(task => task.taskId === identity.taskId)?.gates?.find(value => value.gateId === identity.gateId);
    return ids.length === 1 && ids[0] === identity.graphId && graph?.graphId === identity.graphId
      && gate?.status === 'satisfied' && gate.kind === 'userAction' && gate.label === identity.label
      && JSON.stringify(gate.response) === JSON.stringify(identity.response);
  }) || null;
}

// This race does NOT accept the UI request: it must retain its real 409.
// A separate, explicitly recorded fixture acceptance resolves the question;
// production then rereads it and removes the no-longer-editable draft.
export function assertTaskGateStaleReconciled(proof, threadId) {
  const { identity, before, accepted, after, typed, ui } = proof;
  assertQuestionIdentity(typed, identity, threadId); assertQuestionIdentity(ui, identity, threadId);
  const rejected = assertOneAnswer(before, after, identity, 409);
  assert.equal(rejected.response.code, 'TASK_GATE_STALE');
  assert.deepEqual(posts(after).slice(0, -1), posts(before), 'no old request rewritten');
  assert.equal(posts(accepted).length, posts(before).length + 1);
  const pending = posts(accepted).at(-1);
  assert.equal(pending.sequence, rejected.sequence); assert.equal(accepted.held?.sequence, pending.sequence);
  assert.equal(pending.status, null); assert.equal(pending.delegated, false);
  assert.deepEqual(pending.request, rejected.request, 'the held native submission, not another attempt');
  assert.ok(accepted.controls.some((row, index) => index >= before.controls.length && row.action === 'accept-held'
    && row.result?.status === 200 && row.result.graphId === identity.graphId), 'real independent race acceptance receipt');
  assert.equal(accepted.pauseBroadcast, true); assert.equal(after.pauseBroadcast, true, 'GET reconciliation before queued SSE is released');
  assert.equal(accepted.persisted.answers.length, before.persisted.answers.length + 1);
  const oldAnswerKeys = new Set(before.persisted.answers.map(row => JSON.stringify([row.graphId, row.taskId, row.gateId])));
  const added = accepted.persisted.answers.filter(row => !oldAnswerKeys.has(JSON.stringify([row.graphId, row.taskId, row.gateId])));
  assert.deepEqual(accepted.persisted.answers.filter(row => oldAnswerKeys.has(JSON.stringify([row.graphId, row.taskId, row.gateId]))),
    before.persisted.answers, 'race setup preserves prior answers');
  assert.equal(added.length, 1);
  for (const key of ['graphId', 'taskId', 'gateId']) assert.equal(added[0][key], identity[key]);
  assert.equal(added[0].textSha256, hash(normalized(typed.value)));
  assert.equal(added[0].codePoints, Array.from(normalized(typed.value)).length);
  assert.deepEqual(after.persisted.answers, accepted.persisted.answers, 'rejected UI attempt writes no second answer');
  assert.equal(accepted.fakeProviderTurns.length, before.fakeProviderTurns.length + 1);
  assert.deepEqual(accepted.fakeProviderTurns.slice(0, -1), before.fakeProviderTurns);
  assert.ok(accepted.fakeProviderTurns.every(turn => turn.conversationId === before.original.conversationId));
  assert.deepEqual(after.fakeProviderTurns, accepted.fakeProviderTurns, 'rejection/reconciliation cannot resume again');
  assert.deepEqual(after.requests.filter(row => row.path === '/chat/send'), before.requests.filter(row => row.path === '/chat/send'));
  assert.ok(reconciledTaskGateRead(after, identity, rejected.sequence), 'same original question must have a later real satisfied GET receipt');
  assert.equal(ui.state, 'satisfied'); assert.equal(ui.inputCount, 0); assert.equal(ui.continueCount, 0);
  assert.equal(ui.value, ''); assert.equal(ui.choice, null); assert.equal(ui.continueDisabled, true);
  return true;
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
  assertTaskGateFailurePaint(evidence.errorPaint?.initial, evidence.rejected.typed, evidence.rejected.ui, evidence.rejected.identity, evidence.threadId);
  assertTaskGateFailurePaint(evidence.errorPaint?.beforeCapture, evidence.rejected.typed, evidence.rejected.refreshed, evidence.rejected.identity, evidence.threadId);
  assertOneAnswer(evidence.text.before, evidence.text.after, evidence.text.identity);
  assertCodePointLimit(evidence.text.ui, evidence.text.value, evidence.text.identity.response.maxLength);
  assert.ok(evidence.text.after.persisted.answers.some(row => row.graphId === evidence.text.identity.graphId
    && row.taskId === evidence.text.identity.taskId && row.gateId === evidence.text.identity.gateId
    && row.textSha256 === hash(normalized(evidence.text.value)) && row.codePoints === 20));
  assertNewQuestionCleared(evidence.previousQuestion, evidence.newQuestion);
  assertTaskGateStaleReconciled(evidence.stale, evidence.threadId);
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
      inputCount: row?.querySelectorAll(`[data-testid="${names.text}"],[data-testid="${names.choice}"]`).length || 0,
      continueCount: row?.querySelectorAll(`[data-testid="${names.continue}"]`).length || 0,
      continueDisabled: !button || button.disabled === true || button.getAttribute('aria-disabled') === 'true' };
  }, { selector, names: TASK_GATE_SELECTORS });
}
export async function observeTaskGateTarget(harness, selector) {
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
    return { selector, count: nodes.length, rect: r && { x: r.x, y: r.y, width: r.width, height: r.height },
      visible: !!r && r.width > 0 && r.height > 0 && css.display !== 'none' && css.visibility !== 'hidden',
      inside: !!r && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      hits, clipped, disabled: !node || node.disabled || node.getAttribute('aria-disabled') === 'true',
      scrollDirection: listBox && r ? r.bottom > listBox.bottom ? 'PageDown' : r.top < listBox.top ? 'PageUp' : null : null };
  }, selector);
}

// A noninteractive count label is not a click target. Inspect its actual text
// line rectangles, not the stretched flex span's whitespace. Controls still
// use the unchanged nine-point element hit test above.
export async function observeTaskGateLimit(harness, identity) {
  const selector = `${taskGateRowSelector(identity)} ${testid(TASK_GATE_SELECTORS.limit)}`;
  return chrome(harness, selector => {
    const nodes = [...document.querySelectorAll(selector)], node = nodes.length === 1 ? nodes[0] : null;
    const text = (node?.textContent || '').trim(), fragments = [];
    let styleVisible = !!node?.isConnected && !node.closest('[hidden],[inert],[aria-hidden="true"]');
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let parent = node; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent), r = parent.getBoundingClientRect();
      if (css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) === 0 || css.contentVisibility === 'hidden') styleVisible = false;
      if (css.display === 'inline' || css.display === 'contents') continue;
      const sx = parent.offsetWidth ? r.width / parent.offsetWidth : 1, sy = parent.offsetHeight ? r.height / parent.offsetHeight : 1;
      if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
        clip.left = Math.max(clip.left, r.left + parent.clientLeft * sx);
        clip.right = Math.min(clip.right, r.left + (parent.clientLeft + parent.clientWidth) * sx);
      }
      if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
        clip.top = Math.max(clip.top, r.top + parent.clientTop * sy);
        clip.bottom = Math.min(clip.bottom, r.top + (parent.clientTop + parent.clientHeight) * sy);
      }
    }
    if (node) {
      const range = document.createRange(); range.selectNodeContents(node);
      for (const r of range.getClientRects()) {
        if (r.width <= 0 || r.height <= 0) continue;
        const hits = [.2, .5, .8].map(x => {
          const hit = document.elementFromPoint(r.left + r.width * x, r.top + r.height * .5);
          return { owned: !!hit && (hit === node || node.contains(hit)), tag: hit?.localName || null,
            testId: hit?.getAttribute('data-testid') || null };
        });
        fragments.push({ rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
          inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
          clipped: r.left < clip.left - .5 || r.top < clip.top - .5 || r.right > clip.right + .5 || r.bottom > clip.bottom + .5,
          hits, hitCount: hits.filter(hit => hit.owned).length });
      }
      range.detach?.();
    }
    const list = node?.closest('[data-testid="chat-task-list"]');
    const above = fragments.some(part => part.rect.top < clip.top - .5), below = fragments.some(part => part.rect.bottom > clip.bottom + .5);
    const scrollDirection = list && above && list.scrollTop > .5 ? 'PageUp'
      : list && below && list.scrollTop < list.scrollHeight - list.clientHeight - .5 ? 'PageDown' : null;
    return { selector, count: nodes.length, text, limit: node ? Number(node.dataset.maxLength) : null,
      counted: node ? Number(node.dataset.codePoints) : null, styleVisible, clip, fragments, scrollDirection };
  }, selector);
}

export function taskGateLimitReadable(proof) {
  return proof?.count === 1 && proof.styleVisible === true && typeof proof.text === 'string' && proof.text.trim().length > 0
    && proof.fragments?.length > 0 && proof.fragments.every(part => part.inside === true && part.clipped === false
      && part.hitCount === 3 && part.hits.length === 3 && part.hits.every(hit => hit.owned === true));
}

export function assertTaskGateLimitPaint(proof, ui, identity, raw) {
  assert.ok(taskGateLimitReadable(proof), 'all actual counter text must be painted, unclipped and unoccluded');
  assert.equal(identity.response.kind, 'text');
  assert.equal(proof.text, ui.limitText.trim(), 'the painted label and current observation agree');
  assert.equal(proof.counted, ui.counted); assert.equal(proof.limit, ui.limit);
  assertCodePointLimit({ ...ui, limitText: proof.text }, raw, identity.response.maxLength);
  return true;
}

// One synchronous, read-only paint sample of the whole failed-answer surface.
// Never call ready()/readTaskGateLimit(): they may scroll away a product defect.
export async function observeTaskGateFailurePaint(harness, identity) {
  const selector = taskGateRowSelector(identity);
  return chrome(harness, ({ selector, names }) => {
    const rows = [...document.querySelectorAll(selector)], row = rows.length === 1 ? rows[0] : null;
    const nodes = key => [...(row?.querySelectorAll(`[data-testid="${names[key]}"]`) || [])];
    const one = key => nodes(key).length === 1 ? nodes(key)[0] : null;
    const bounds = node => {
      let styleVisible = !!node?.isConnected && !node.closest('[hidden],[inert],[aria-hidden="true"]');
      const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      for (let parent = node; parent; parent = parent.parentElement) {
        const css = getComputedStyle(parent), r = parent.getBoundingClientRect();
        if (css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) === 0 || css.contentVisibility === 'hidden') styleVisible = false;
        if (css.display === 'inline' || css.display === 'contents') continue;
        const sx = parent.offsetWidth ? r.width / parent.offsetWidth : 1, sy = parent.offsetHeight ? r.height / parent.offsetHeight : 1;
        if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
          clip.left = Math.max(clip.left, r.left + parent.clientLeft * sx);
          clip.right = Math.min(clip.right, r.left + (parent.clientLeft + parent.clientWidth) * sx);
        }
        if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
          clip.top = Math.max(clip.top, r.top + parent.clientTop * sy);
          clip.bottom = Math.min(clip.bottom, r.top + (parent.clientTop + parent.clientHeight) * sy);
        }
      }
      return { styleVisible, clip };
    };
    const inside = r => !!r && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    const clipped = (r, clip) => !r || r.left < clip.left - .5 || r.top < clip.top - .5 || r.right > clip.right + .5 || r.bottom > clip.bottom + .5;
    const rect = r => r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    const notice = one('notice'), noticeBounds = bounds(notice), fragments = [];
    if (notice) {
      const range = document.createRange(); range.selectNodeContents(notice);
      for (const r of range.getClientRects()) {
        if (r.width <= 0 || r.height <= 0) continue;
        const hits = [.2, .5, .8].map(x => {
          const hit = document.elementFromPoint(r.left + r.width * x, r.top + r.height * .5);
          return { owned: !!hit && (hit === notice || notice.contains(hit)) };
        });
        fragments.push({ rect: rect(r), inside: inside(r), clipped: clipped(r, noticeBounds.clip),
          hits, hitCount: hits.filter(hit => hit.owned).length });
      }
      range.detach?.();
    }
    const button = key => {
      const node = one(key), r = node?.getBoundingClientRect(), paint = bounds(node); let hits = 0;
      if (r) for (const x of [.2, .5, .8]) for (const y of [.2, .5, .8]) {
        const hit = document.elementFromPoint(r.left + r.width * x, r.top + r.height * y);
        if (hit === node || node.contains(hit)) hits++;
      }
      return { selector: `${selector} [data-testid=${JSON.stringify(names[key])}]`, count: nodes(key).length,
        rect: rect(r), visible: paint.styleVisible && !!r && r.width > 0 && r.height > 0,
        inside: inside(r), clipped: clipped(r, paint.clip), hits,
        disabled: !node || node.disabled === true || node.getAttribute('aria-disabled') === 'true' };
    };
    const checked = row?.querySelector(`[data-testid="${names.choice}"]:checked`);
    return { ui: { count: rows.length, threadId: window.__egdesk?.state?.codex?.activeThreadId || null,
      graphId: row?.dataset.graphId, taskId: row?.dataset.taskId, gateId: row?.dataset.gateId, responseKey: row?.dataset.responseKey,
      question: one('question')?.textContent || '', next: one('next')?.textContent || '',
      value: one('text')?.value ?? '', choice: checked?.dataset.choiceId ?? null, notice: notice?.textContent || '' },
      notice: { count: nodes('notice').length, text: (notice?.textContent || '').trim(), ...noticeBounds, fragments },
      continue: button('continue'), cancel: button('cancel') };
  }, { selector, names: TASK_GATE_SELECTORS });
}

export function assertTaskGateFailurePaint(proof, typed, current, identity, threadId) {
  assertQuestionIdentity(typed, identity, threadId); assertQuestionIdentity(current, identity, threadId);
  assertDraftRetained(typed, current);
  assertQuestionIdentity(proof?.ui, identity, threadId);
  assertDraftRetained(current, proof.ui, { notice: true });
  assert.ok(taskGateLimitReadable(proof.notice), 'FULL error text must be painted, unclipped and unoccluded without scrolling');
  assert.equal(proof.notice.text, current.notice.trim(), 'all current error text, not a shortened substitute');
  for (const key of ['continue', 'cancel']) {
    const target = proof[key];
    assert.equal(target?.selector, `${taskGateRowSelector(identity)} ${testid(TASK_GATE_SELECTORS[key])}`);
    assert.ok(target.count === 1 && target.visible === true && target.inside === true && target.clipped === false
      && target.hits === 9 && target.disabled === false, `${key}: FULL enabled button must be painted and hit at all nine points without scrolling`);
  }
  return true;
}

export async function readTaskGateLimit(harness, identity, deadlineMs,
  { read = observeTaskGateLimit, wait = waitFor } = {}) {
  const observations = [], scrolls = [];
  const sample = async () => {
    assertBeforeDeadline(deadlineMs);
    const proof = await read(harness, identity);
    observations.push(proof);
    if (observations.length > 3) observations.shift();
    return proof;
  };
  for (let attempt = 0; attempt < 6; attempt++) {
    const proof = await sample();
    if (taskGateLimitReadable(proof)) return { proof, observations, scrolls };
    if (!proof.scrollDirection) break;
    assertBeforeDeadline(deadlineMs);
    scrolls.push(await harness.scrollWithKey('[data-testid="chat-task-list"]', proof.scrollDirection));
  }
  const proof = await wait(harness, sample, taskGateLimitReadable, deadlineMs);
  return { proof, observations, scrolls };
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
      const target = await waitFor(harness, () => observeTaskGateTarget(harness, selector), value => value.count === 1 && value.visible, deadlineMs);
      if (target.inside && !target.clipped && target.hits === 9 && !target.disabled) return;
      if (!target.scrollDirection) break;
      assertBeforeDeadline(deadlineMs);
      await harness.scrollWithKey('[data-testid="chat-task-list"]', target.scrollDirection);
    }
    await waitFor(harness, () => observeTaskGateTarget(harness, selector), value => value.count === 1 && value.visible && value.inside && !value.clipped && value.hits === 9 && !value.disabled, deadlineMs);
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
  const evidence = { nativeInputs: true, domInjection: false, noPosts: [], limitPaint: [], errorPaint: {}, captures: [] };
  const readableLimit = async (identity, raw) => {
    const painted = await readTaskGateLimit(harness, identity, deadlineMs), current = await read(identity);
    assertTaskGateLimitPaint(painted.proof, current, identity, raw);
    evidence.limitPaint.push({ identity, inputValue: current.value, ...painted });
  };
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
  // This is the existing initial question, not a changed-choice scenario.
  // Preserve the full question/options and selected value beside the image;
  // its readability still requires Main's visual review.
  evidence.captures.push({ stage: 'initial-choice-before-continue', identity: choice, ui: selectedChoice,
    screenshot: await capture('task-gate-initial-choice-before-continue'), visualReview: 'pending' });
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
  check('Native choice has one real accepted receipt; duplicate disabled input did not add a POST', posts(afterAttempt).length === posts(whileHeld).length);
  await control('complete-turn');
  await waitFor(harness, () => read(text), value => value.count === 1 && value.limit === 20, deadlineMs);
  assertQuestionIdentity(await read(text), text, local.id);
  const tooLong = '😀'.repeat(21);
  await withoutPost('typing', () => type(text, tooLong));
  await readableLimit(text, tooLong);
  const over = await read(text); assertCodePointLimit(over, tooLong, text.response.maxLength);
  await withoutPost('oversize', async () => {
    if (over.continueDisabled) { assertBeforeDeadline(deadlineMs); await harness.click(field(text, 'continue')); }
    else await click(field(text, 'continue'));
  });
  assertCodePointLimit(await read(text), tooLong, text.response.maxLength, { invalid: true });
  check('Visible counter matches native code points and contract; oversized input sent no POST', true);
  const validText = '😀'.repeat(20);
  await type(text, validText);
  await withoutPost('text-enter', () => press('Enter', field(text, 'text')));
  const secret = 'pw: hunter2';
  await type(text, secret);
  const typed = await read(text), rejectedBefore = await state();
  await click(field(text, 'continue'));
  const rejectedAfter = await waitState(value => posts(value).at(-1)?.response?.code === 'TASK_GATE_ANSWER_PRIVATE');
  const rejectedUi = await waitFor(harness, () => read(text), value => !!value.notice, deadlineMs);
  evidence.errorPaint.initial = await observeTaskGateFailurePaint(harness, text);
  assertTaskGateFailurePaint(evidence.errorPaint.initial, typed, rejectedUi, text, local.id);
  const beforeRefresh = await state(); await refresh(text);
  const refreshed = await read(text), afterRefresh = await state();
  evidence.noPosts.push({ stage: 'same-question-refresh', before: beforeRefresh, after: afterRefresh });
  evidence.rejected = { identity: text, before: rejectedBefore, after: rejectedAfter, typed, ui: rejectedUi, refreshed };
  assertDraftRetained(rejectedUi, refreshed, { notice: true });
  evidence.errorPaint.beforeCapture = await observeTaskGateFailurePaint(harness, text);
  assertTaskGateFailurePaint(evidence.errorPaint.beforeCapture, typed, refreshed, text, local.id);
  check('Same-question private-answer rejection and refresh retain draft and explanation', true);
  // Capture the preserved failed answer/error and existing Continue action
  // before the fixture changes the question or any text is replaced.
  evidence.captures.push({ stage: 'same-question-text-failure', identity: text, ui: refreshed,
    screenshot: await capture('task-gate-same-question-text-failure'), visualReview: 'pending' });
  // Change identity while an actual failed draft and notice are still present,
  // not after a successful answer has already cleared them.
  evidence.previousQuestion = await read(text);
  await control('next-question'); fixture = await state();
  const next = identify(fixture.plans[1], fixture.plans[1].questions[0]);
  const emptyNext = await waitFor(harness, () => read(next), value => value.count === 1 && value.limit === 8, deadlineMs);
  assertQuestionIdentity(emptyNext, next, local.id); evidence.newQuestion = emptyNext;
  assertNewQuestionCleared(evidence.previousQuestion, emptyNext);
  check('Changed question has its own identity and an empty draft', true);
  await type(text, validText);
  await readableLimit(text, validText);
  const textUi = await read(text), textBefore = await state();
  await click(field(text, 'continue'));
  const textAfter = await waitState(value => posts(value).at(-1)?.status === 200 && value.persisted.answers.length === 1 && value.fakeProviderTurns.length === 3);
  evidence.text = { identity: text, before: textBefore, after: textAfter, ui: textUi, value: validText };
  assertOneAnswer(textBefore, textAfter, text);
  check('Native valid text has one real accepted receipt and persisted answer', true);
  await control('complete-turn');
  await type(next, '다음 답변');
  const staleTyped = await read(next), staleBefore = await state();
  evidence.stale = { identity: next, before: staleBefore, typed: staleTyped };
  await control('hold-next'); await click(field(next, 'continue'));
  await waitState(value => value.held !== null);
  await control('accept-held');
  evidence.stale.accepted = await waitState(value => value.persisted.answers.length === staleBefore.persisted.answers.length + 1
    && value.fakeProviderTurns.length === staleBefore.fakeProviderTurns.length + 1);
  await control('release');
  const staleAfter = await waitState(value => posts(value).at(-1)?.response?.code === 'TASK_GATE_STALE');
  evidence.stale.after = staleAfter;
  const rejectedSequence = assertOneAnswer(staleBefore, staleAfter, next, 409).sequence;
  check('Native raced submission receives real 409 TASK_GATE_STALE, not a successful UI answer', true);
  evidence.stale.after = await waitState(value => reconciledTaskGateRead(value, next, rejectedSequence));
  evidence.stale.ui = await waitFor(harness, () => read(next), value => value.state === 'satisfied'
    && value.inputCount === 0 && value.continueCount === 0, deadlineMs);
  evidence.stale.after = await state();
  assertTaskGateStaleReconciled(evidence.stale, local.id);
  check('Stale reconciliation rereads the same resolved question with no second answer or replay', true);
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
