#!/usr/bin/env node
// Main owns startup. This script attaches only to the explicitly selected QA
// profile + fixture transport. It never launches Firefox or a native model.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { assertQaFixtureManifest, qaProfileSourceFingerprints } from './egdesk-chat-qa-profile.mjs';
import { assertPublishedBriefing, assertContextSendBindings, assertFrozenFileReadAfterMutation,
  assertStoredAgentDelivery, captureContextReadEvidence, fingerprintQaBytes, observeQaFixtureFile,
  assertContextSourceChangePanel, assertContextSourceChangeScope, assertContextSourceRequest,
  classifyContextSourceTerminal, assertBriefingCommentDraft, assertBriefingCommentStore,
  assertBriefingCommentReceipt, assertBriefingCommentGetDelta, summarizeBriefingCommentGetDelta, summarizeBriefingFailureState,
  assertBriefingPanelExpected, assertBriefingPanelInvariant, planBriefingPanelWheel } from './egdesk-context-qa-contract.mjs';
import { attributeSelector, chrome, loopbackJson, newQaThread, runUiFlow,
  selectQaThread, selectorForId, sendFromComposer, visible, waitUntil, replaceFieldText } from './egdesk-qa-ui-flow.mjs';
import { qaBridgeUrl, assertQaProfileBridge } from './egdesk-qa-fixture-isolation.mjs';
import { FirefoxMcpChatHarness } from './firefox-mcp-chat-harness.mjs';
import { assertBeforeDeadline, parseDeadline, observeGuard } from './verify-firefox-mcp-headless-ui-regression.mjs';

export function assertContextQaEnvironment(env = process.env) {
  assert.ok(env.EGDESK_QA_FIXTURE_TRANSPORT === '1' && env.EGDESK_QA_STATE_FIXTURES === '1'
    && typeof env.EGDESK_QA_FIXTURE_TOKEN === 'string' && env.EGDESK_QA_FIXTURE_TOKEN.length >= 16
    && env.EGDESK_QA_REAL_TURN === '0', 'Context UI fixture requires explicit fixture/state opt-ins and token; native turns are forbidden');
  qaBridgeUrl('/health', env); // Validates the isolated port; never use the production fallback.
}

export function parseContextQaCli(argv, now = Date.now()) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(['--profile', '--deadline-utc', '--phase'].includes(argv[i]) && !values.has(argv[i])
      && argv[i + 1] && !argv[i + 1].startsWith('--'), 'Expected unique --profile, --deadline-utc and optional --phase values');
    values.set(argv[i], argv[i + 1]);
  }
  assert.ok(values.has('--profile') && values.has('--deadline-utc'), '--profile and --deadline-utc are required');
  const phase = values.get('--phase') || 'core';
  assert.ok(['core', 'restored-range', 'source-change', 'comments'].includes(phase), '--phase must be core, restored-range, source-change or comments');
  return { profile: values.get('--profile'), deadlineMs: parseDeadline(values.get('--deadline-utc'), now), phase };
}
const hook = name => attributeSelector('data-testid', name);
const camera = harness => chrome(harness, () => ({ pan: { ...window.__egdesk.state.panTarget }, zoom: window.__egdesk.state.zoomTarget }));
const sameCamera = (a, b) => Math.abs(a.pan.x - b.pan.x) < 0.5 && Math.abs(a.pan.y - b.pan.y) < 0.5 && Math.abs(a.zoom - b.zoom) < 0.001;
const shortError = error => String(error?.message || error).split('\n')[0].slice(0, 300);
const shortStack = error => String(error?.stack || '').split('\n').filter(line => /^\s+at /.test(line)).slice(0, 8).join('\n').slice(0, 1600);

export function summarizeContextObservation(value) {
  if (Array.isArray(value)) return { count: value.length, nodes: value.slice(0, 2).map(summarizeContextObservation) };
  if (!value || typeof value !== 'object') return { type: typeof value, ...(typeof value === 'boolean' ? { value } : {}) };
  const summary = {};
  for (const key of ['observedAt', 'count', 'visible', 'inside', 'disabled', 'clipped', 'hits', 'exists', 'statusCount', 'statusReadable', 'packetExpanded', 'cameraSettled', 'preparing', 'rowCount', 'readable', 'full']) {
    if (typeof value[key] === 'boolean' || Number.isFinite(value[key])) summary[key] = value[key];
  }
  for (const key of ['roomId', 'sourceId', 'statusSourceId', 'statusConversationId', 'state', 'reason', 'id', 'testId', 'holdId', 'requestId', 'terminalCause', 'activeThreadId', 'briefingId', 'stepId', 'status', 'listState', 'clientRequestId']) {
    if (typeof value[key] === 'string') summary[key] = value[key].slice(0, 256);
  }
  if (value.rect) summary.rect = Object.fromEntries(['x', 'y', 'left', 'top', 'right', 'bottom', 'width', 'height']
    .filter(key => Number.isFinite(value.rect[key])).map(key => [key, value.rect[key]]));
  if (Array.isArray(value.hitSamples)) summary.hitSamples = value.hitSamples.slice(0, 9).map(point => ({
    x: Number.isFinite(point?.x) ? point.x : null, y: Number.isFinite(point?.y) ? point.y : null,
    matched: point?.matched === true,
    hit: point?.hit ? Object.fromEntries([['tag', 40], ['id', 128], ['class', 256]]
      .map(([key, limit]) => [key, typeof point.hit[key] === 'string' ? point.hit[key].slice(0, limit) : ''])) : null,
  }));
  // Never retain auth, account, token, source text, metadata text or payload.
  if (value.scope) summary.scope = Object.fromEntries(['roomId', 'engineId', 'engineProfileId']
    .filter(key => typeof value.scope[key] === 'string').map(key => [key, value.scope[key].slice(0, 256)]));
  if (value.statusEvidence) summary.statusEvidence = summarizeContextObservation(value.statusEvidence);
  if (value.panel) summary.panel = { rect: summarizeContextObservation({ rect: value.panel.rect }).rect,
    client: summarizeContextObservation({ rect: value.panel.client }).rect,
    ...Object.fromEntries(['scrollTop', 'clientHeight', 'scrollHeight'].map(key => [key, value.panel[key]])) };
  if (value.access) summary.access = summarizeContextObservation(value.access);
  if (Array.isArray(value.rows)) summary.rowParts = value.rows.filter(row => row.id === value.access?.identity?.commentId)
    .concat(value.rows.slice(-2)).filter((row, i, all) => all.findIndex(other => other.id === row.id) === i).slice(0, 2)
    .map(row => ({ id: String(row.id).slice(0, 64), parts: Object.fromEntries(['body', 'target', 'draft-status']
      .filter(key => row.parts?.[key]).map(key => [key, summarizeContextObservation(row.parts[key])])) }));
  if (Array.isArray(value.alerts)) summary.alerts = value.alerts.slice(0, 3)
    .map(row => ({ kind: row.kind, text: String(row.text).slice(0, 300) }));
  return summary;
}

function contextDiagnostic(diagnostics, fields) {
  if (!diagnostics) return null;
  diagnostics.total = (diagnostics.total || 0) + 1;
  const record = { sequence: diagnostics.total, status: 'pending', ...fields };
  (diagnostics.records ||= []).push(record);
  if (diagnostics.records.length > 24) { diagnostics.records.shift(); diagnostics.dropped = (diagnostics.dropped || 0) + 1; }
  return record;
}

export function assertContextFresh(value, now = Date.now()) {
  assert.ok(Number.isFinite(value?.observedAt) && value.observedAt <= now + 2 && now - value.observedAt <= 80,
    'Context screen observation is stale or missing its capture time');
  return value;
}

// Only observational work may lose this race. Never pass a click, mutation or
// an entire scenario: its continuation would otherwise outlive the deadline.
export async function readContextBeforeDeadline(read, deadlineMs, { now = Date.now, timeoutMs = 500 } = {}) {
  assertBeforeDeadline(deadlineMs, now());
  const end = Math.min(deadlineMs, now() + timeoutMs); let timer;
  try {
    const value = await Promise.race([Promise.resolve().then(() => { assertBeforeDeadline(end, now()); return read(); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Context observation timed out before deadline')), end - now()); })]);
    assertBeforeDeadline(end, now());
    return value;
  } finally { clearTimeout(timer); }
}

export async function waitContextBeforeDeadline(read, accept, deadlineMs,
  { now = Date.now, timeoutMs = 15000, intervalMs = 80, diagnostics, label = 'context-state', selector = null, phase = null,
    screen = false, requestSummary = null } = {}) {
  const end = Math.min(deadlineMs, now() + timeoutMs);
  const record = contextDiagnostic(diagnostics, { kind: 'wait', label: label.slice(0, 256), selector: selector?.slice(0, 512), phase,
    startedAt: now(), end, samples: 0, last: null });
  try {
    while (now() < end) {
      const value = await readContextBeforeDeadline(read, end, { now });
      if (record) {
        record.samples++; record.last = summarizeContextObservation(value); record.receivedAt = now();
        if (requestSummary) {
          try { record.last.requests = requestSummary(value); }
          catch { record.last.requestSummaryFailed = true; } // Never replace the original assertion/error.
        }
      }
      assertBeforeDeadline(end, now());
      if (screen) assertContextFresh(value, now());
      if (accept(value)) { if (record) record.status = 'passed'; return value; }
      await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(intervalMs, end - now()))));
    }
    throw new Error('Context state did not arrive before deadline');
  } catch (error) {
    if (record) { record.status = 'failed'; record.error = shortError(error); record.stack = shortStack(error); }
    throw error;
  } finally {
    if (record) record.finishedAt = now();
  }
}

export async function contextQaJson(route, deadlineMs,
  { method = 'GET', body, env = process.env, now = Date.now, fetchImpl = fetch, includeHttpStatus = false, signal } = {}) {
  assertContextQaEnvironment(env); assertBeforeDeadline(deadlineMs, now());
  const controller = new AbortController(), end = Math.min(deadlineMs, now() + 5000);
  const abort = () => controller.abort(signal.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Context HTTP deadline reached')), end - now());
  try {
    controller.signal.throwIfAborted();
    const response = await fetchImpl(qaBridgeUrl(route, env), { method, redirect: 'error', signal: controller.signal,
      headers: { 'X-EGDESK-QA-Token': env.EGDESK_QA_FIXTURE_TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    controller.signal.throwIfAborted(); assertBeforeDeadline(end, now());
    const value = await readContextBeforeDeadline(() => response.json(), end, { now, timeoutMs: 5000 });
    controller.signal.throwIfAborted(); assertBeforeDeadline(end, now());
    if (includeHttpStatus) return { httpStatus: response.status, body: value };
    assert.ok(response.ok, `${route.split('?')[0]} failed (${response.status}): ${value.code || value.error || 'request failed'}`);
    return value;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export function guardContextHarness(harness, deadlineMs, { now = Date.now, diagnostics } = {}) {
  const close = harness.close?.bind(harness);
  let stopped = false, closing;
  const active = () => { assert.ok(!stopped, 'Context transport stopped; no further input'); assertBeforeDeadline(deadlineMs, now()); };
  const stop = () => {
    if (!closing) {
      stopped = true;
      // The owned MCP's close rejects pending RPCs synchronously, sends EOF,
      // and then awaits its bounded cleanup. It never signals Firefox/bridge.
      try { closing = Promise.resolve(close()); } catch (error) { closing = Promise.reject(error); }
      closing.catch(() => {}); // finally/close below owns the cleanup result
    }
    return closing;
  };
  if (close) harness.close = stop;
  // Also guard the public methods used INSIDE native UID/profile preflight.
  // A timed-out preflight cannot resume later and dispatch the native action.
  for (const key of ['assertRemoteProfile', 'evaluateChrome', 'inspect', 'snapshot', 'uidFor']) {
    if (typeof harness[key] !== 'function') continue;
    const original = harness[key].bind(harness);
    harness[key] = (...args) => { active(); return readContextBeforeDeadline(() => { active(); return original(...args); }, deadlineMs, { now }); };
  }
  for (const key of ['click', 'fill', 'press', 'typeText', 'wheelAt', 'clickPoint']) {
    if (typeof harness[key] !== 'function') continue;
    const original = harness[key].bind(harness);
    harness[key] = async (...args) => {
      active();
      assert.ok(close, 'Native input requires an owned transport cancellation/close path');
      const record = contextDiagnostic(diagnostics, { kind: 'native', method: key, startedAt: now(),
        selector: (key === 'press' ? args[1] : ['click', 'fill'].includes(key) ? args[0] : null)?.slice(0, 512) });
      let timer;
      try {
        const value = await Promise.race([Promise.resolve().then(() => { active(); return original(...args); }),
          new Promise((_, reject) => { timer = setTimeout(() => {
            // Cancellation happens BEFORE rejecting the waiter. This is not
            // an abandoned native promise: stop/EOF closes its RPC transport.
            stop();
            if (record) { record.cancelRequestedAt = now(); record.inputOutcome = 'unknown'; record.remoteExecutionCancellationProven = false; }
            reject(new Error('Context native deadline: owned transport shutdown requested; remote input outcome unknown'));
          }, Math.max(0, deadlineMs - now())); })]);
        active(); if (record) record.status = 'returned'; return value;
      } catch (error) {
        if (record) { record.status = 'failed'; record.error = shortError(error); }
        throw error;
      } finally { clearTimeout(timer); if (record) record.finishedAt = now(); }
    };
  }
  return harness;
}

export async function observeContextControl(harness, selector) {
  return chrome(harness, selector => {
    const nodes = [...document.querySelectorAll(selector)], node = nodes.length === 1 ? nodes[0] : null;
    const r = node?.getBoundingClientRect(), css = node && getComputedStyle(node);
    let clipped = false, hits = 0;
    const hitSamples = [];
    if (r) {
      for (let p = node.parentElement; p; p = p.parentElement) {
        const b = p.getBoundingClientRect(), s = getComputedStyle(p);
        if (/(auto|scroll|hidden|clip)/.test(s.overflowY) && (r.top < b.top || r.bottom > b.bottom)
          || /(auto|scroll|hidden|clip)/.test(s.overflowX) && (r.left < b.left || r.right > b.right)) clipped = true;
      }
      for (const x of [.2, .5, .8]) for (const y of [.2, .5, .8]) {
        const px = r.left + r.width * x, py = r.top + r.height * y;
        const hit = document.elementFromPoint(px, py), matched = hit === node || node.contains(hit);
        if (matched) hits++;
        // Describe only this existing hit test: no extra probe, text or input.
        hitSamples.push({ x: px, y: py, matched, hit: hit ? { tag: hit.localName.slice(0, 40),
          id: (hit.id || '').slice(0, 128), class: (hit.getAttribute('class') || '').slice(0, 256) } : null });
      }
    }
    const state = window.__egdesk?.state, c = state?.codex, thread = c?.threads.find(t => t.id === c.activeThreadId);
    return { observedAt: Date.now(), scope: { roomId: c?.activeThreadId, owner: c?.codexAccountKey,
      engineId: thread?.engineId, engineProfileId: thread?.engineProfileId, roomGeneration: c?.activityRoomGeneration,
      auth: c?.authStatus && { loggedIn: c.authStatus.isLoggedIn, identityStatus: c.authStatus.identityStatus,
        accountId: c.authStatus.accountId, accountEmail: c.authStatus.accountEmail, authMode: c.authStatus.authMode },
      zoom: state?.zoom, pan: state?.pan, width: innerWidth, height: innerHeight },
      identity: node && { id: node.id, testId: node.dataset.testid, threadId: node.dataset.threadId,
        sourceId: node.dataset.sourceId, snapshotId: node.dataset.snapshotId, runId: node.dataset.runId },
      rect: r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      count: nodes.length, visible: !!r && r.width > 0 && r.height > 0 && css.display !== 'none' && css.visibility === 'visible',
      inside: !!r && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      disabled: !node || node.disabled || node.getAttribute('aria-disabled') === 'true', clipped, hits, hitSamples };
  }, selector);
}

export async function clickContextControl(harness, selector, deadlineMs, { read = observeContextControl, now = Date.now, diagnostics } = {}) {
  const acceptable = value => value.count === 1 && value.visible && value.inside && !value.clipped && !value.disabled && value.hits === 9;
  const ready = await waitContextBeforeDeadline(() => read(harness, selector), acceptable, deadlineMs,
    { now, diagnostics, label: 'native-control-ready', selector, phase: 'before-input', screen: true });
  const final = await readContextBeforeDeadline(() => read(harness, selector), deadlineMs, { now });
  assert.ok(acceptable(final), 'Context control changed before native input');
  // Diagnostic hit descriptions do not add or remove any acceptance condition.
  const { hitSamples: finalSamples, ...finalGuard } = final, { hitSamples: readySamples, ...readyGuard } = ready;
  assert.deepEqual({ ...finalGuard, observedAt: null }, { ...readyGuard, observedAt: null }, 'Context input scope/geometry changed before native input');
  assert.ok(Number.isFinite(final.observedAt) && final.observedAt >= ready.observedAt
    && now() - final.observedAt <= 80 && final.observedAt <= now() + 2, 'Context final control observation is stale');
  assertBeforeDeadline(deadlineMs, now());
  return harness.click(selector); // one native click, no scroll/rescue/DOM input
}

export async function observeContextSourceChange(harness) {
  return chrome(harness, () => {
    const c = window.__egdesk.state.codex, thread = c.threads.find(t => t.id === c.activeThreadId);
    const ChatState = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
    const panel = document.getElementById('egd-codex-input-panel');
    const article = panel?.querySelector('[data-testid="chat-input-snapshot"]');
    const changes = article?.querySelectorAll('[data-testid="chat-input-source-change"]') || [], change = changes[0];
    const sourceLabel = article?.querySelector('[data-testid="chat-input-source-label"]');
    const delivery = article?.querySelector('[data-testid="chat-input-delivery"], [data-testid="chat-input-delivery-status"]');
    const sourceMetadata = article?.querySelector('[data-testid="chat-input-source-details"]');
    const packetMetadata = article?.querySelector('[data-testid="chat-input-delivery-details"]');
    const sourceLines = [...(sourceMetadata?.querySelectorAll('p') || [])].map(node => node.textContent);
    const packetLines = [...(packetMetadata?.querySelectorAll('p') || [])].map(node => node.textContent);
    const sourceId = article?.dataset.snapshotId || null;
    let scope = null;
    try { scope = { ...ChatState.chatContextRequestScope(thread, c), owner: ChatState.codexAccountKey(c.authStatus), sourceId }; } catch {}
    let readable = !!change;
    if (change) {
      const range = document.createRange(); range.selectNodeContents(change);
      const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
      readable = rects.length > 0 && rects.every(r => {
        if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) return false;
        for (let p = change; p; p = p.parentElement) {
          const b = p.getBoundingClientRect(), s = getComputedStyle(p);
          if (s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) === 0) return false;
          if (/(auto|scroll|hidden|clip)/.test(s.overflowY) && (r.top < b.top || r.bottom > b.bottom)
            || /(auto|scroll|hidden|clip)/.test(s.overflowX) && (r.left < b.left || r.right > b.right)) return false;
        }
        return [.2, .5, .8].every(x => { const hit = document.elementFromPoint(r.left + r.width * x, r.top + r.height / 2);
          return hit === change || change.contains(hit); });
      });
    }
    return { observedAt: Date.now(), exists: !!panel, roomId: thread?.id || null, scope, sourceId, statusCount: changes.length,
      state: change?.dataset.state || null, reason: change?.dataset.reason || null,
      statusSourceId: change?.dataset.sourceId || null, statusConversationId: change?.dataset.conversationId || null,
      statusText: change?.textContent || '', statusReadable: readable,
      changedAt: change?.querySelector('[data-testid="chat-input-change-detected-at"]')?.getAttribute('datetime') || null,
      placedBetweenSourceAndDelivery: !!sourceLabel && !!delivery && !!change
        && !!(sourceLabel.compareDocumentPosition(change) & 4) && !!(change.compareDocumentPosition(delivery) & 4),
      sourceLabel: sourceLabel?.textContent || '', sourceText: article?.querySelector('[aria-label="당시 캡처 본문"]')?.textContent || '',
      sourceMetadata: sourceMetadata?.textContent || '',
      sourceHashes: sourceLines.filter(text => text.startsWith('캡처 hash: ')).map(text => text.slice('캡처 hash: '.length)),
      rangeHashes: sourceLines.filter(text => text.startsWith('표시 범위 hash: ')).map(text => text.slice('표시 범위 hash: '.length)),
      packetId: article?.querySelector('[data-testid="chat-input-delivery"]')?.dataset.packetId || null,
      packetExpanded: article?.querySelector('[data-testid="chat-input-delivery"]')?.open === true,
      packetText: article?.querySelector('[aria-label="실제로 전달된 payload 원문"]')?.textContent ?? null,
      packetMetadata: packetMetadata?.textContent ?? null,
      packetMetadataValues: packetLines.filter(text => text.includes(' · packet ')).map(text => {
        const match = /^(.*?) · packet (.*?) · hash (.*?)$/.exec(text);
        return match ? { mode: match[1], packetId: match[2], hash: match[3] } : { invalid: true };
      }) };
  });
}

const sourceRoute = (room, source) => ({ engineId: room.engineId, engineProfileId: room.engineProfileId,
  clientThreadId: room.clientThreadId, conversationId: room.conversationId, sourceId: source.sourceId });

export function assertSourceChangeSeed(seed) {
  assert.ok(seed?.version === 1 && seed.setupOnly === true && seed.synthetic === true && seed.ready === true,
    'Source-change requires explicit prelaunch synthetic seed; never manufacture live UI state');
  assert.ok(typeof seed.account?.key === 'string' && seed.account.key.startsWith('codex:'));
  assert.equal(seed.identities?.length, 2, 'Exactly the two declared seed rooms');
  assert.equal(new Set(seed.identities.map(room => room.conversationId)).size, 2);
  assert.equal(new Set(seed.identities.map(room => room.clientThreadId)).size, 2);
  for (const [i, room] of seed.identities.entries()) {
    assert.equal(room.sources?.length, 1);
    const source = room.sources[0], scope = { owner: seed.account.key, ...sourceRoute(room, source) };
    assertContextSourceChangeScope(scope, scope);
    assert.equal(room.engineProfileId, 'codex-default');
    for (const key of ['title', 'runId', 'answerId']) assert.ok(typeof room[key] === 'string' && room[key]);
    assert.equal(source.kind, i === 0 ? 'file' : 'browser');
    assert.equal(source.snapshotId, source.sourceId); assert.notEqual(source.selectionId, source.sourceId);
    for (const key of ['captureHash', 'payloadHash']) assert.match(source[key] || '', /^[0-9a-f]{64}$/);
    assert.ok(source.packetId && (i === 0 ? source.path : source.viewId));
  }
  assert.deepEqual(seed.counts?.runtimeAtSetup, { captureBatches: 0, fileCaptureOperations: 0, sends: 0, deliveries: 0 });
  return seed;
}

export async function observeContextUnchanged(read, verify, deadlineMs, { diagnostics, label = 'post-terminal-unchanged' } = {}) {
  let since = null, previous = null, samples = 0;
  await waitContextBeforeDeadline(read, value => {
    verify(value);
    assertContextFresh(value);
    const at = value.observedAt;
    assert.ok(previous === null || at >= previous, 'Screen observation time moved backwards');
    if (previous === null || at - previous > 120) { since = at; samples = 0; }
    if (at !== previous) samples++;
    previous = at;
    return samples >= 3 && at - since >= 240;
  }, deadlineMs, { timeoutMs: 3000, diagnostics, label, phase: 'after-transport-terminal', screen: true });
  return { samples, observedWindowMs: previous - since };
}

export async function verifyContextSourceChange({ harness, deadlineMs, initial, request, check, capture, result },
  { observe = observeContextSourceChange, select = selectQaThread, click = clickContextControl } = {}) {
  const seed = assertSourceChangeSeed(initial.sourceChangeSeed), [fileRoom, browserRoom] = seed.identities;
  const file = fileRoom.sources[0], browser = browserRoom.sources[0];
  result.setup = seed;
  result.boundary = 'Prelaunch synthetic history and fixture-given tracking state; not live file-event detection or native provider delivery';
  result.sourceChange = [];
  result.transportProofs = [];
  const diagnostics = result.diagnostics ||= { total: 0, dropped: 0, records: [] };
  const state = () => request('/__qa/state');
  const control = body => request('/__qa/context-config', { method: 'POST', body });
  const setStatus = (room, source, status, reason = null, changedAt = null) =>
    control({ sourceStatus: { ...sourceRoute(room, source), state: status, reason, changedAt } });
  const panel = () => observe(harness);
  const native = selector => click(harness, selector, deadlineMs, { diagnostics });
  const wait = (read, accept, options = {}) => waitContextBeforeDeadline(read, accept, deadlineMs, { diagnostics, ...options });
  const currentPanel = () => wait(panel, () => true, { label: 'current-inspector', phase: 'scope-read', screen: true });
  const scope = (room, source) => ({ owner: seed.account.key, ...sourceRoute(room, source) });
  // Shared room selection uses only native UI; wrap every click in the same
  // strict target check. No new thread, title rewrite, source capture or send.
  const nativeHarness = Object.create(harness);
  for (const method of ['evaluateChrome', 'inspect', 'press', 'fill', 'typeText']) nativeHarness[method] = harness[method]?.bind(harness);
  nativeHarness.click = native;
  const close = async () => {
    if ((await currentPanel()).exists) { await native('[aria-label="첨부 패널 닫기"]'); await wait(panel, p => !p.exists,
      { label: 'inspector-closed', phase: 'close', selector: '#egd-codex-input-panel', screen: true }); }
  };
  const selectRoom = async room => {
    await close();
    if ((await harness.inspect(hook('chat-activity-panel'))).length) await native('[aria-label="활동 기록 닫기"]');
    await select(nativeHarness, { id: room.clientThreadId, title: room.title, wireClientThreadId: room.clientThreadId });
  };
  const open = async (room, source) => {
    await close();
    const current = await currentPanel();
    if (current.roomId !== room.clientThreadId) await selectRoom(room);
    if (!(await harness.inspect(hook('chat-activity-panel'))).length) await native(hook('chat-activity-open'));
    const history = hook('chat-input-history') + attributeSelector('data-run-id', room.runId);
    await wait(() => harness.inspect(history), nodes => nodes.length === 1, { label: 'history-row', phase: 'open-history', selector: history });
    if (!await chrome(harness, selector => document.querySelector(selector)?.open === true, history)) await native(`${history} > summary`);
    await native(`${history} ${hook('chat-input-history-open')}${attributeSelector('data-snapshot-id', source.sourceId)}`);
    return wait(panel, p => p.exists && p.sourceId === source.sourceId,
      { label: 'inspector-open', phase: 'open-history', selector: '#egd-codex-input-panel', screen: true });
  };
  const readStored = async (room, source) => {
    const { sourceId, ...routing } = sourceRoute(room, source);
    const params = new URLSearchParams({ ...routing, packetId: source.packetId });
    const stored = captureContextReadEvidence(await request(`/context/captures/${encodeURIComponent(sourceId)}?${params}`));
    assert.equal(stored.capture.sourceId, sourceId); assert.equal(stored.capture.hash, source.captureHash);
    assert.equal(stored.delivered?.hash, source.payloadHash);
    assertStoredAgentDelivery(stored.delivered, { packetId: source.packetId,
      binding: { conversationId: room.conversationId, runId: room.runId, answerId: room.answerId }, expectedToolText: stored.delivered.text });
    return stored;
  };
  const snapshots = new Map([[file.sourceId, await readStored(fileRoom, file)], [browser.sourceId, await readStored(browserRoom, browser)]]);
  const baselines = new Map();
  const expected = (room, source, status, reason = null, changedAt = null) => ({ scope: scope(room, source),
    state: status, reason, changedAt, snapshot: snapshots.get(source.sourceId), before: baselines.get(source.sourceId) });
  const prove = async (label, room, source, status, reason = null, changedAt = null) => {
    const p = await wait(panel, value => value.exists && value.sourceId === source.sourceId && value.state === status,
      { label, phase: 'source-status', selector: hook('chat-input-source-change'), screen: true });
    assertContextSourceChangePanel(p, expected(room, source, status, reason, changedAt));
    baselines.set(source.sourceId, p);
    result.sourceChange.push({ label, sourceId: source.sourceId, conversationId: room.conversationId, state: status, reason,
      source: fingerprintQaBytes(p.sourceText), payload: fingerprintQaBytes(p.packetText), changedAt: p.changedAt });
    assert.ok(result.sourceChange.length <= 16, 'Bounded source-change evidence records');
    check(label, true); return p;
  };
  const hold = async (room, source) => {
    // Product metadata requests have their own 10s limit. Do not extend it or
    // sleep blindly; failure to finish this bounded native sequence must fail.
    const deadlineAt = Math.min(deadlineMs, Date.now() + 9000);
    assertBeforeDeadline(deadlineAt);
    const armed = await control({ sourceStatusResponse: { ...sourceRoute(room, source), mode: 'hold', deadlineAt } });
    assert.ok(typeof armed.holdId === 'string' && armed.holdId && armed.requestId === null, 'Exact armed hold receipt is required');
    return { room, source, holdId: armed.holdId, deadlineAt };
  };
  const receipt = async ticket => {
    const rows = (await state()).sourceStatus?.receipts;
    assert.ok(Array.isArray(rows) && rows.length <= 64, 'Bounded source-status receipts are required');
    const matches = rows.filter(row => row.holdId === ticket.holdId);
    assert.equal(matches.length, 1, 'The exact hold receipt is missing or duplicated');
    if (matches[0].requestId !== null) assert.equal(rows.filter(row => row.requestId === matches[0].requestId).length, 1,
      'Received source GET requestId must be unique across retained holds');
    return matches[0];
  };
  const received = async ticket => {
    const value = await wait(() => receipt(ticket), row => row.requestId !== null,
      { label: 'source-get-actually-received', phase: 'before-native-action', timeoutMs: Math.max(1, ticket.deadlineAt - Date.now()) });
    return assertContextSourceRequest(value, { route: sourceRoute(ticket.room, ticket.source), account: seed.account.variant, holdId: ticket.holdId });
  };
  const release = async (ticket, before, actionStartedAt, actionFinishedAt, label) => {
    const response = await request('/__qa/context-release', { method: 'POST', includeHttpStatus: true,
      body: { phase: 'sources', ...sourceRoute(ticket.room, ticket.source), requestId: before.requestId } });
    // A 409 alone proves nothing. Only this exact already-closed receipt with
    // no attempted write can be classified as transportAborted.
    assert.ok(response.httpStatus === 200 || response.httpStatus === 409 && response.body.code === 'QA_SOURCE_RESPONSE_ALREADY_CLOSED',
      'Unexpected source release failure; no guessed success for NOT_HELD');
    const terminal = await wait(() => receipt(ticket), row => row.terminalCause !== null,
      { label: 'source-get-terminal-receipt', phase: label, timeoutMs: Math.min(3000, Math.max(1, ticket.deadlineAt - Date.now())) });
    const classification = classifyContextSourceTerminal(before, terminal, { actionStartedAt, actionFinishedAt, release: response });
    result.transportProofs.push({ label, classification, actionStartedAt, actionFinishedAt, httpStatus: response.httpStatus,
      received: before, terminal: structuredClone(terminal), uiCallbackDeliveryProven: false });
    assert.ok(result.transportProofs.length <= 4, 'Bounded source transport proofs');
    return classification;
  };
  const runtime = value => ({ captures: value.context.captureBatches, fileReads: value.context.fileCaptureOperations,
    sends: value.observed.sends.length, deliveries: value.context.deliveries.length });
  check('runtime starts with zero captures, sends and provider deliveries; seeded history is separate',
    Object.values(runtime(initial)).every(value => value === 0));
  await selectRoom(fileRoom);
  await open(fileRoom, file);
  await prove('active means no change detected within tracking, not latest original', fileRoom, file, 'active');

  const changedAt = Date.now();
  await setStatus(fileRoom, file, 'stale', 'fileChanged', changedAt); const firstHold = await hold(fileRoom, file);
  await open(fileRoom, file);
  const firstRequest = await received(firstHold);
  await prove('loading metadata does not block the old body or stored payload', fileRoom, file, 'loading');
  const payloadActionAt = Date.now();
  await native(`#egd-codex-input-panel ${hook('chat-input-delivery')} > summary`);
  const pendingPacket = await wait(panel, p => p.packetExpanded, { label: 'pending-status-payload-open', phase: 'payload', screen: true });
  assertContextSourceChangePanel(pendingPacket, expected(fileRoom, file, 'loading'));
  check('stored payload opens through native input while status is still pending', true);
  assert.equal(await release(firstHold, firstRequest, payloadActionAt, Date.now(), 'pending-payload'), 'serverResponseFinished');
  const fileStale = await prove('fileChanged labels its detection time without changing capture or payload', fileRoom, file, 'stale', 'fileChanged', changedAt);
  assert.equal(fileStale.packetExpanded, true, 'A source-status response collapsed the independently opened payload');
  await capture('source-change-file-stale');
  await control({ sourceStatusResponse: { ...sourceRoute(fileRoom, file), mode: 'error' } });
  await open(fileRoom, file);
  await prove('source-status failure leaves immutable body and payload readable', fileRoom, file, 'failed');

  // The held old stale response must not overwrite a replacement panel showing
  // active metadata for the same source. Neither state certifies freshness.
  const replacementHold = await hold(fileRoom, file); await open(fileRoom, file);
  const replacementRequest = await received(replacementHold);
  await prove('old source-status request is visibly pending before replacement', fileRoom, file, 'loading');
  await setStatus(fileRoom, file, 'active'); const replacementAt = Date.now(); await open(fileRoom, file);
  await prove('replacement panel owns its new source-status request', fileRoom, file, 'active');
  await release(replacementHold, replacementRequest, replacementAt, Date.now(), 'panel-replacement');
  result.replacementSafety = await observeContextUnchanged(panel,
    p => assertContextSourceChangePanel(p, expected(fileRoom, file, 'active')), deadlineMs, { diagnostics, label: 'replacement-unchanged' });
  check('after exact transport terminal evidence, replacement panel metadata and payload remain unchanged', true);

  const roomHold = await hold(fileRoom, file); await open(fileRoom, file);
  const roomRequest = await received(roomHold);
  await prove('original room status is pending before native room switch', fileRoom, file, 'loading');
  const roomActionAt = Date.now(); await selectRoom(browserRoom); await open(browserRoom, browser);
  await prove('other native conversation displays only its bound source and packet', browserRoom, browser, 'active');
  await release(roomHold, roomRequest, roomActionAt, Date.now(), 'room-switch');
  result.roomSafety = await observeContextUnchanged(panel,
    p => assertContextSourceChangePanel(p, expected(browserRoom, browser, 'active')), deadlineMs, { diagnostics, label: 'room-unchanged' });
  check('after exact transport terminal evidence, the other conversation inspector remains unchanged', true);
  const navigatedAt = Date.now();
  await setStatus(browserRoom, browser, 'stale', 'navigated', navigatedAt); await open(browserRoom, browser);
  await prove('navigated status preserves the historical Browser source and payload', browserRoom, browser, 'stale', 'navigated', navigatedAt);
  const unknownAt = Date.now();
  await setStatus(browserRoom, browser, 'stale', 'unknown', unknownAt); await open(browserRoom, browser);
  await prove('unknown stale reason stays bounded to original-change metadata', browserRoom, browser, 'stale', 'unknown', unknownAt);
  const closeHold = await hold(browserRoom, browser); await open(browserRoom, browser);
  const closeRequest = await received(closeHold);
  await prove('status is pending before explicit panel close', browserRoom, browser, 'loading');
  const closeActionAt = Date.now(); await close(); await release(closeHold, closeRequest, closeActionAt, Date.now(), 'panel-close');
  result.closeSafety = await observeContextUnchanged(panel, p => assert.equal(p.exists, false, 'Late status reopened the closed inspector'), deadlineMs,
    { diagnostics, label: 'closed-inspector-unchanged' });
  check('after exact transport terminal evidence, the closed inspector stays closed', true);
  await setStatus(browserRoom, browser, 'missing'); await open(browserRoom, browser);
  await prove('absent tracking is explicitly unknown freshness, never active', browserRoom, browser, 'missing');
  await capture('source-change-missing-not-latest');
  for (const [room, source] of [[fileRoom, file], [browserRoom, browser]]) {
    assert.deepEqual(await readStored(room, source), snapshots.get(source.sourceId), 'Status scenarios rewrote stored capture/range/packet');
  }
  const final = await state();
  assert.deepEqual(runtime(final), runtime(initial), 'Metadata inspection created a capture, file read, send or delivery');
  check('source-change UI inspection created no capture/send/provider delivery', true);
  result.runtime = runtime(final);
}

export async function recordBriefingFailureState(error, result, deadlineMs,
  { eligible = false, profile, env = process.env, now = Date.now, fetchImpl = fetch } = {}) {
  if (result.failureState) return; // Exactly one attempt; no retry after failure.
  result.error = shortError(error); result.errorStack = shortStack(error);
  const startedAt = now(), end = Math.min(deadlineMs, startedAt + 750);
  const record = result.failureState = { status: 'skipped', startedAt, deadlineMs: end, attempts: 0 };
  if (!eligible || typeof profile !== 'string' || !profile || startedAt >= end) {
    record.reason = startedAt >= end ? 'No deadline budget' : 'Owned headless fixture not verified';
    return;
  }
  const controller = new AbortController(); record.status = 'pending';
  try {
    const value = await readContextBeforeDeadline(() => {
      record.attempts++;
      return contextQaJson('/__qa/state', end, { env, now, fetchImpl, signal: controller.signal });
    }, end, { now, timeoutMs: 750 });
    assert.ok(value?.fixture === true && value.profile === profile, 'Failure diagnostic fixture ownership mismatch');
    const summary = summarizeBriefingFailureState(value);
    assertBeforeDeadline(end, now());
    record.summary = summary; record.status = 'captured';
  } catch {
    record.status = 'failed';
    record.reason = now() >= end ? 'Failure state deadline reached' : 'Failure state unavailable or unverified';
    // Do not expose an HTTP error body or overwrite the original error/stack.
  } finally {
    controller.abort(); // Also abort HTTP when the independent read bound wins.
    record.finishedAt = now();
  }
}

export async function recordContextFailure(harness, error, result, deadlineMs,
  { eligible = false, now = Date.now, screenshotName = 'source-change-failure' } = {}) {
  if (result.failureCapture) return; // one static failure image at most
  result.error = shortError(error); result.errorStack = shortStack(error);
  const startedAt = now(), end = Math.min(deadlineMs, startedAt + 2000);
  const shot = result.failureCapture = { status: 'skipped', startedAt, deadlineMs: end };
  if (!eligible || typeof harness?.screenshot !== 'function' || startedAt >= end) {
    shot.reason = !eligible ? 'Owned headless fixture not verified' : startedAt >= end ? 'No deadline budget' : 'Screenshot unavailable';
    return;
  }
  shot.status = 'pending';
  try {
    const captured = await readContextBeforeDeadline(() => harness.screenshot(screenshotName,
      { allowHeadlessChromeFallback: true, deadlineMs: end }), end, { now, timeoutMs: 2000 });
    shot.status = 'captured'; shot.path = captured;
    result.screenshots.push(captured);
  } catch (diagnosticError) {
    shot.status = 'failed'; shot.error = shortError(diagnosticError);
    // Never replace the scenario exception, retry, or perform recovery input.
  } finally { shot.finishedAt = now(); }
}

export async function runContextSourceChange({ profile, deadlineMs, phase = 'source-change' },
  { env = process.env, createHarness = options => new FirefoxMcpChatHarness(options), scenario = verifyContextSourceChange } = {}) {
  assertContextQaEnvironment(env); assertBeforeDeadline(deadlineMs);
  assert.equal(phase, 'source-change'); assert.equal(env.EGDESK_QA_CONTEXT_SOURCE_CHANGE_SEED, '1', 'Explicit prelaunch source-change seed required');
  assertQaFixtureManifest(profile);
  const isolation = assertQaProfileBridge(profile, env);
  let harness, failureCaptureAllowed = false;
  const result = { kind: 'context-briefing-fixture-source-change', phase, deadlineMs, automatedAssertionsPassed: false,
    nativeInputs: true, domInjection: false, providerTurn: 'fixture-only-no-native-provider', checks: [], screenshots: [], visualReview: 'pending' };
  try {
    assertBeforeDeadline(deadlineMs);
    result.diagnostics = { total: 0, dropped: 0, records: [] };
    harness = guardContextHarness(createHarness({ profile, marionettePort: 2829 }), deadlineMs, { diagnostics: result.diagnostics });
    result.fixtureIsolation = isolation; result.profileSources = qaProfileSourceFingerprints(profile);
    await readContextBeforeDeadline(() => harness.connect(), deadlineMs, { timeoutMs: 10000 });
    const guard = await observeGuard(harness);
    assert.ok(guard.headless && guard.mounted && guard.documentURI === 'chrome://browser/content/browser.xhtml', 'Owned headless mounted browser required');
    const request = (route, options) => contextQaJson(route, deadlineMs, { ...options, env });
    const initial = await request('/__qa/state');
    assert.ok(initial.fixture && initial.profile === profile, 'Fixture profile differs from the selected browser');
    failureCaptureAllowed = true;
    await scenario({ harness, deadlineMs, initial, request, result,
      check(label, condition) { result.checks.push({ label, passed: !!condition }); assert.ok(condition, label); },
      async capture(name) {
        assertBeforeDeadline(deadlineMs);
        const captured = await harness.screenshot(name, { allowHeadlessChromeFallback: true, deadlineMs });
        assertBeforeDeadline(deadlineMs); result.screenshots.push(captured);
      } });
    assertBeforeDeadline(deadlineMs); result.automatedAssertionsPassed = true;
  } catch (error) { await recordContextFailure(harness, error, result, deadlineMs, { eligible: failureCaptureAllowed }); }
  finally {
    try { await harness?.close(); } catch (error) { result.cleanupError = error.message; result.automatedAssertionsPassed = false; }
    if (harness?.evidenceDir) {
      result.evidenceFile = path.join(harness.evidenceDir, 'result.json');
      fs.writeFileSync(result.evidenceFile, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    }
  }
  return result;
}

const briefingRoute = room => ({ engineId: room.engineId, engineProfileId: room.engineProfileId,
  clientThreadId: room.clientThreadId, conversationId: room.conversationId, briefingId: room.briefing.id });
const commentUuid = value => typeof value === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);

export function assertBriefingCommentsSeed(seed) {
  assertSourceChangeSeed(seed); // shared synthetic two-room/capture identity contract
  assert.equal(seed.storage?.comments, 'context-json-records');
  assert.equal(seed.counts.seed.briefings, 2); assert.equal(seed.counts.seed.comments, 0);
  for (const room of seed.identities) {
    assert.ok(commentUuid(room.briefing?.id)); assert.ok(room.briefing.steps.length >= 1);
    assert.equal(new Set(room.briefing.steps.map(step => step.id)).size, room.briefing.steps.length);
    for (const step of room.briefing.steps) {
      assert.ok(typeof step.id === 'string' && step.id);
      assert.ok(Array.isArray(step.sourceIds) && step.sourceIds.length > 0 && step.sourceIds.length <= 6);
      assert.equal(new Set(step.sourceIds).size, step.sourceIds.length);
      assert.ok(step.sourceIds.every(id => room.sources.some(source => source.sourceId === id)));
    }
    const p = room.preservation;
    assert.ok(typeof p?.draftText === 'string' && p.draftText.trim(), 'Nonempty seeded draft required for preservation proof');
    assert.ok(Array.isArray(p.inputSources) && Array.isArray(p.briefingInputs) && p.briefingInputs.length > 0,
      'Nonempty existing immutable attachment required for preservation proof');
    assert.deepEqual(p.briefingCommentRefs, []);
    assert.equal(new Set(p.briefingInputs.map(ref => ref.sourceId)).size, p.briefingInputs.length);
    for (const ref of p.briefingInputs) {
      const source = room.sources.find(source => source.sourceId === ref.sourceId);
      assert.ok(source, 'Existing attachment must identify an actual seeded immutable capture');
      assert.equal(ref.hash, source.captureHash);
    }
  }
  return seed;
}

export async function observeBriefingComments(harness, roomIds, selector = null) {
  return chrome(harness, ({ roomIds, selector }) => {
    const surface = window.__egdesk.state, c = surface.codex, ChatState = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
    const root = document.querySelector('[data-testid="answer-briefing"]');
    const query = name => root?.querySelector(`[data-testid="briefing-comment-${name}"]`);
    const rect = node => {
      if (!node) return null; const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    const visible = node => {
      if (!node) return false; const r = rect(node), s = getComputedStyle(node);
      return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility === 'visible' && Number(s.opacity) !== 0;
    };
    const readable = node => {
      if (!node || !node.textContent) return false;
      const range = document.createRange(); range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
      return rects.length > 0 && rects.every(r => {
        if (r.left < 0 || r.top < 0 || r.right > innerWidth || r.bottom > innerHeight) return false;
        for (let p = node; p; p = p.parentElement) {
          const b = p.getBoundingClientRect(), s = getComputedStyle(p);
          if (s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) === 0
            || /(auto|scroll|hidden|clip)/.test(s.overflowY) && (r.top < b.top || r.bottom > b.bottom)
            || /(auto|scroll|hidden|clip)/.test(s.overflowX) && (r.left < b.left || r.right > b.right)) return false;
        }
        return [.2, .5, .8].every(x => { const hit = document.elementFromPoint(r.left + r.width * x, r.top + r.height / 2);
          return hit === node || node.contains(hit); });
      });
    };
    const partEvidence = node => ({ rect: rect(node), readable: readable(node) });
    const panelRect = rect(root), client = root && { left: panelRect.left + root.clientLeft, top: panelRect.top + root.clientTop,
      right: panelRect.left + root.clientLeft + root.clientWidth, bottom: panelRect.top + root.clientTop + root.clientHeight };
    const panel = root && { id: root.id, rect: panelRect, client, scrollTop: root.scrollTop, scrollLeft: root.scrollLeft,
      clientHeight: root.clientHeight, clientWidth: root.clientWidth, scrollHeight: root.scrollHeight, scrollWidth: root.scrollWidth };
    const nearestScroll = node => {
      if (!node || !root?.contains(node) || node.closest('textarea,input,select,[contenteditable]')) return null;
      for (let p = node; p; p = p.parentElement) {
        if (/(auto|scroll|overlay)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight + 1) return p;
        if (p === root) return null;
      }
      return null;
    };
    let wheelPoint = null;
    if (root && visible(root)) for (const fx of [.08, .5, .92]) for (const fy of [.2, .5, .8]) {
      if (wheelPoint) continue;
      const x = Math.round(client.left + (client.right - client.left) * fx), y = Math.round(client.top + (client.bottom - client.top) * fy);
      let hits = 0;
      for (const dx of [-2, 0, 2]) for (const dy of [-2, 0, 2]) {
        const px = x + dx, py = y + dy;
        if (px > client.left && px < client.right && py > client.top && py < client.bottom
          && px >= 0 && px < innerWidth && py >= 0 && py < innerHeight && nearestScroll(document.elementFromPoint(px, py)) === root) hits++;
      }
      if (hits === 9) wheelPoint = { x, y, hits, scrollTarget: root.id };
    }
    const targets = selector ? [...document.querySelectorAll(selector)] : [], target = targets.length === 1 ? targets[0] : null;
    const tr = rect(target); let hits = 0;
    if (tr) for (const x of [.2, .5, .8]) for (const y of [.2, .5, .8]) {
      const hit = document.elementFromPoint(tr.left + tr.width * x, tr.top + tr.height * y);
      if (hit === target || target.contains(hit)) hits++;
    }
    const access = selector && { selector, count: targets.length, insidePanel: !!target && !!root?.contains(target), rect: tr,
      identity: target && { id: target.id, testId: target.dataset.testid, commentId: target.dataset.commentId || null },
      visible: visible(target), disabled: !!target?.disabled || target?.getAttribute('aria-disabled') === 'true', hits,
      full: !!tr && !!client && tr.left >= Math.max(0, client.left) && tr.top >= Math.max(0, client.top)
        && tr.right <= Math.min(innerWidth, client.right) && tr.bottom <= Math.min(innerHeight, client.bottom), wheelPoint };
    const alerts = [...document.querySelectorAll('#egd-board-notice, [data-testid="answer-briefing"] [role="alert"]')]
      .filter(visible).slice(0, 3).map(node => ({ kind: node.id === 'egd-board-notice' ? 'board-notice' : 'briefing-alert',
        text: (node.textContent || '').slice(0, 300), rect: rect(node) }));
    const rows = [...(root?.querySelectorAll('[data-testid="briefing-comment-row"]') || [])];
    return { observedAt: Date.now(), activeThreadId: c.activeThreadId, exists: !!root,
      presentationId: c.briefingSession?.presentationId || null, sessionThreadId: c.briefingSession?.threadId || null, roomGeneration: c.activityRoomGeneration,
      camera: { zoom: surface.zoom, zoomTarget: surface.zoomTarget, pan: { ...surface.pan }, panTarget: { ...surface.panTarget } },
      viewport: { width: innerWidth, height: innerHeight }, panel, access, alerts,
      cameraSettled: surface.zoom === surface.zoomTarget && surface.pan.x === surface.panTarget.x && surface.pan.y === surface.panTarget.y,
      briefingId: root?.dataset.briefingId || null, stepId: root?.dataset.stepId || null,
      title: c.briefingSession?.briefing.title || '', preparing: !!c.briefingSession?.preparing,
      status: query('status')?.dataset.state || null, statusText: query('status')?.textContent || '', statusReadable: readable(query('status')),
      clientRequestId: query('status')?.dataset.clientRequestId || null, listState: query('list')?.dataset.state || null,
      inputText: root?.querySelector('[data-testid="briefing-comment"]')?.value || '',
      originalText: query('unconfirmed-body')?.textContent || '', originalReadable: readable(query('unconfirmed-body')),
      retryEnabled: query('unconfirmed')?.hidden === false && query('retry')?.disabled === false,
      retryClientRequestId: query('retry')?.dataset.clientRequestId || null,
      statusEvidence: partEvidence(query('status')),
      rowCount: rows.length, rows: rows.slice(0, 8).map(row => {
        const part = name => row.querySelector(`[data-testid="briefing-comment-${name}"]`);
        return { id: row.dataset.commentId, seq: Number(row.dataset.commentSeq), stepId: row.dataset.stepId,
          clientRequestId: row.dataset.clientRequestId, text: part('body')?.textContent || '', target: part('target')?.textContent || '',
          draftStatus: part('draft-status')?.textContent || '', included: part('include')?.disabled === true,
          readable: ['body', 'target', 'draft-status'].every(name => readable(part(name))),
          parts: Object.fromEntries(['body', 'target', 'draft-status'].map(name => [name, partEvidence(part(name))])) };
      }),
      rooms: roomIds.slice(0, 2).map(id => {
        const thread = c.threads.find(item => item.id === id); let scope = null;
        try { scope = { owner: ChatState.codexAccountKey(c.authStatus), ...ChatState.chatContextRequestScope(thread, c) }; } catch {}
        return { id, scope, draft: c.threadDrafts?.[id] || '', inputSources: thread?.inputSources || [],
          briefingInputs: thread?.briefingInputs || [], briefingCommentRefs: thread?.briefingCommentRefs || [] };
      }) };
  }, { roomIds, selector });
}

export async function reachBriefingPanelTarget({ read, wheel, accept, selector, expected, deadlineMs, budget, diagnostics,
  beforeWheel, afterWheel, now = Date.now }) {
  const end = Math.min(deadlineMs, now() + 15000);
  const sample = async () => {
    const value = await readContextBeforeDeadline(read, end, { now }); assertContextFresh(value, now());
    assertBriefingPanelExpected(value, expected);
    assert.deepEqual(value.alerts, [], 'Unexpected visible Briefing notice/alert');
    assert.equal(value.access?.selector, selector); assert.equal(value.access.count, 1); assert.equal(value.access.insidePanel, true);
    return value;
  };
  const baseline = structuredClone(await sample()); assert.equal(baseline.cameraSettled, true);
  const geometry = value => JSON.stringify({ panel: value.panel, access: value.access });
  const settle = async () => {
    let signature, since, previous, samples = 0;
    return waitContextBeforeDeadline(sample, value => {
      assertBriefingPanelInvariant(baseline, value);
      const current = geometry(value), at = value.observedAt;
      assert.ok(previous === undefined || at >= previous, 'Briefing observation time moved backwards');
      if (current !== signature || previous === undefined || at - previous > 120) { signature = current; since = at; samples = 0; }
      if (at !== previous) samples++; previous = at;
      return samples >= 3 && at - since >= 240;
    }, end, { now, timeoutMs: 3000, screen: true, diagnostics, label: 'briefing-panel-settled', selector, phase: 'comments-wheel' });
  };
  let value = await settle();
  for (let used = 0; ; used++) {
    if (accept(value)) return value;
    assert.ok(used < 6 && budget.total < 32, 'Briefing native wheel limit reached (6/access, 32/flow)');
    const requestBefore = await beforeWheel();
    const final = await sample(); assertBriefingPanelInvariant(baseline, final);
    assert.equal(geometry(final), geometry(value), 'Briefing geometry/hit target changed immediately before wheel');
    assert.ok(final.observedAt >= value.observedAt);
    const input = planBriefingPanelWheel(final);
    const record = { sequence: ++budget.total, selector, input, before: summarizeContextObservation(final), status: 'pending' };
    (budget.records ||= []).push(record); assert.ok(budget.records.length <= 32);
    try {
      assertBeforeDeadline(end, now()); await wheel(input); assertBeforeDeadline(end, now());
      value = await settle(); record.after = summarizeContextObservation(value);
      record.requests = await afterWheel(requestBefore); record.status = 'settled';
      // A fixture read is not a fresh screen observation. Reobserve before
      // accepting or planning another input; never count its latency as stable.
      const latest = await sample(); assertBriefingPanelInvariant(baseline, latest);
      if (geometry(latest) !== geometry(value)) value = await settle(); else value = latest;
    } catch (error) { record.status = 'failed'; record.error = shortError(error); throw error; }
  }
}

export async function verifyBriefingComments({ harness, deadlineMs, initial, request, check, capture, result },
  { observe = observeBriefingComments, select = selectQaThread, click = clickContextControl, replace = replaceFieldText,
    reach = reachBriefingPanelTarget } = {}) {
  const seed = assertBriefingCommentsSeed(initial.briefingCommentsSeed), [a, b] = seed.identities;
  const ids = seed.identities.map(room => room.clientThreadId), step = a.briefing.steps[0];
  const diagnostics = result.diagnostics ||= { total: 0, dropped: 0, records: [] };
  result.setup = seed; result.comments = [];
  result.boundary = 'Prelaunch synthetic Briefing/history; native UI writes real Context comment records; no provider turn or native publication proof';
  const state = () => request('/__qa/state'); // Never GET/POST the production comments route from QA.
  const read = async (selector = null) => {
    const value = await observe(harness, ids, selector);
    if (value.alerts?.length) result.visibleAlerts = value.alerts.slice(0, 3);
    assert.deepEqual(value.alerts, [], 'Unexpected visible Briefing notice/alert'); return value;
  };
  const wait = (read, accept, options = {}) => waitContextBeforeDeadline(read, accept, deadlineMs, { diagnostics, ...options });
  const ui = (accept = () => true, label = 'comments-state') => wait(read, accept,
    { screen: true, label, selector: hook('answer-briefing'), phase: 'comments' });
  let expectedRoom = a;
  const scopedControl = async (_h, selector) => {
    const value = await observeContextControl(harness, selector);
    assert.equal(value.scope.roomId, expectedRoom.clientThreadId, 'Comment native input crossed room');
    assert.equal(value.scope.owner, seed.account.key, 'Comment native input crossed account');
    for (const key of ['engineId', 'engineProfileId']) assert.equal(value.scope[key], expectedRoom[key]);
    return value;
  };
  const preparedControl = prepared => async (_h, selector) => {
    const value = await scopedControl(_h, selector);
    if (prepared) {
      assert.equal(value.scope.zoom, prepared.camera.zoom); assert.deepEqual(value.scope.pan, prepared.camera.pan);
      assert.equal(value.scope.width, prepared.viewport.width); assert.equal(value.scope.height, prepared.viewport.height);
      const current = await read(selector); assertContextFresh(current);
      assertBriefingPanelInvariant(prepared, current);
      assert.ok(current.access.full && current.access.hits === 9 && !current.access.disabled, 'Briefing control changed after settlement');
    }
    return value;
  };
  const native = async selector => {
    const prepared = /data-testid="briefing-(comment(?:-|"\])|exit)/.test(selector) ? await ensure(selector, 'control') : null;
    return click(harness, selector, deadlineMs, { diagnostics, read: preparedControl(prepared) });
  };
  const nativeHarness = Object.create(harness);
  for (const method of ['evaluateChrome', 'inspect', 'press', 'fill', 'typeText']) nativeHarness[method] = harness[method]?.bind(harness);
  nativeHarness.click = native;
  // Keep the existing replaceFieldText sequence; guard each of its native
  // key/text calls with the same full-box/nine-hit/fresh-scope gate, not a click.
  const guardedFieldInput = async (selector, action) => {
    const prepared = selector === hook('briefing-comment') ? await ensure(selector, 'control') : null;
    return clickContextControl({ click: action }, selector, deadlineMs, { diagnostics, read: preparedControl(prepared) });
  };
  nativeHarness.press = (key, selector) => guardedFieldInput(selector, () => harness.press(key, selector));
  nativeHarness.typeText = value => guardedFieldInput(hook('briefing-comment'), () => harness.typeText(value));
  const draft = (value, room) => {
    const matches = value.rooms.filter(item => item.id === room.clientThreadId); assert.equal(matches.length, 1);
    const expected = { owner: seed.account.key, ...briefingRoute(room) }; delete expected.briefingId;
    assert.deepEqual(matches[0].scope, expected, 'Comment observation crossed exact account/engine/profile/client/native scope');
    return structuredClone(matches[0]);
  };
  const runtime = value => ({ captures: value.context.captureBatches, fileReads: value.context.fileCaptureOperations,
    sends: value.observed.sends.length, deliveries: value.context.deliveries.length });
  const rows = (value, room) => assertBriefingCommentStore(value, { room, account: seed.account.variant });
  const sameRoute = (left, right) => left && right && Object.keys(left).length === Object.keys(right).length
    && Object.keys(left).every(key => left[key] === right[key]);
  let capturedEpoch;
  const receipts = value => {
    assert.ok(value.briefingComments.receipts.length <= 64);
    for (const receipt of value.briefingComments.receipts) {
      assertBriefingCommentReceipt(receipt, { account: seed.account.variant, epoch: capturedEpoch });
      assert.ok(seed.identities.some(room => sameRoute(briefingRoute(room), receipt.R)), 'Unexpected comment request scope');
    }
    return value.briefingComments.receipts;
  };
  const postCount = value => receipts(value).filter(row => row.method === 'POST' && row.receivedAt !== null).length;
  let getCheckpoint = structuredClone(receipts(initial));
  assert.equal(getCheckpoint.filter(row => row.method === 'GET').length, 0, 'Fresh comments phase must start before any production GET');
  result.getAudits = [];
  const auditGets = (value, count, label, room = a, options = {}) => {
    const current = receipts(value), delta = assertBriefingCommentGetDelta(getCheckpoint, current,
      { count, route: briefingRoute(room), account: seed.account.variant, epoch: capturedEpoch, ...options });
    if (capturedEpoch === undefined && delta.length) {
      capturedEpoch = delta[0].epoch; receipts(value);
      result.commentRequestScope = { R: briefingRoute(room), account: seed.account.variant, epoch: capturedEpoch };
    }
    assert.ok(result.getAudits.length < 64, 'Bounded action GET audit exhausted');
    result.getAudits.push({ label, count, epoch: capturedEpoch ?? null, requestIds: delta.map(row => row.requestId) });
    getCheckpoint = structuredClone(current); return delta;
  };
  const beforeGets = async label => auditGets(await state(), 0, `${label}:before`);
  const afterGets = async (label, count, room = a, options = {}) => wait(state, value => {
    const priorIds = new Set(getCheckpoint.filter(row => row.receivedAt !== null).map(row => row.requestId));
    const delta = receipts(value).filter(row => row.method === 'GET' && !priorIds.has(row.requestId));
    assert.ok(delta.length <= count, 'Unexpected total received production GET delta');
    if (delta.length < count || delta.some(row => row.terminalCause === null)) return false;
    auditGets(value, count, `${label}:after`, room, options); return true;
  }, { label: `${label}-all-production-GETs`, phase: 'comments-requests', timeoutMs: 2000,
    requestSummary: value => summarizeBriefingCommentGetDelta(getCheckpoint, value.briefingComments?.receipts, { action: label, expected: count }) });
  result.wheel = { total: 0, records: [], currentAccountEpochObserved: false,
    scopeBoundary: 'Same observed owner/room, existing request epoch, and zero additional comment GET/POST; no global account-epoch invariance claim' };
  result.statusProofs = [];
  const wheelState = value => ({ posts: postCount(value), gets: receipts(value).filter(row => row.method === 'GET').length,
    runtime: runtime(value), stored: seed.identities.map(room => rows(value, room)) });
  const noWheelRequests = (before, after) => {
    assertBriefingCommentGetDelta(before, receipts(after), { count: 0, account: seed.account.variant, epoch: capturedEpoch });
    getCheckpoint = structuredClone(receipts(after));
  };
  const ensure = async (selector, kind, commentId = null) => reach({ selector, deadlineMs, budget: result.wheel, diagnostics,
    expected: { owner: seed.account.key, route: briefingRoute(expectedRoom), stepId: expectedRoom.briefing.steps[0].id },
    read: () => read(selector), wheel: input => harness.wheelAt(input),
    accept: value => value.access?.full && (kind === 'control' ? value.access.hits === 9 && !value.access.disabled
      : kind === 'row' ? value.rows.find(row => row.id === commentId)?.readable === true
      : value.statusReadable === true),
    beforeWheel: async () => {
      const value = await state(); noWheelRequests(getCheckpoint, value);
      return { receipts: structuredClone(receipts(value)), counts: wheelState(value) };
    },
    afterWheel: async before => {
      const value = await state(); noWheelRequests(before.receipts, value);
      const counts = wheelState(value); assert.deepEqual(counts, before.counts, 'Native panel scroll changed requests/store/provider counts');
      return { before: { posts: before.counts.posts, gets: before.counts.gets }, after: { posts: counts.posts, gets: counts.gets } };
    },
  });
  const readStored = async room => {
    const source = room.sources[0], route = briefingRoute(room); delete route.briefingId;
    const record = captureContextReadEvidence(await request(`/context/captures/${source.sourceId}?${new URLSearchParams({ ...route, packetId: source.packetId })}`));
    assert.equal(record.capture.sourceId, source.sourceId); assert.equal(record.capture.hash, source.captureHash);
    assert.equal(record.delivered.hash, source.payloadHash);
    assertStoredAgentDelivery(record.delivered, { packetId: source.packetId, binding: {
      conversationId: room.conversationId, runId: room.runId, answerId: room.answerId }, expectedToolText: record.delivered.text });
    return record;
  };
  const captures = new Map();
  for (const room of seed.identities) captures.set(room.clientThreadId, await readStored(room));
  const before = await ui(), initialDrafts = new Map();
  for (const room of seed.identities) {
    const value = draft(before, room), expected = room.preservation;
    assert.equal(value.draft, expected.draftText);
    for (const key of ['inputSources', 'briefingInputs', 'briefingCommentRefs']) assert.deepEqual(value[key], expected[key]);
    initialDrafts.set(room.clientThreadId, value); assert.deepEqual(rows(initial, room), []);
  }
  assert.equal(postCount(initial), 0); assert.ok(Object.values(runtime(initial)).every(value => value === 0));
  check('prelaunch nonempty drafts/immutable attachments match seed; runtime capture/send/provider counts are zero', true);
  const exitPanel = async () => {
    if ((await ui()).exists) {
      await beforeGets('close-briefing'); await native(hook('briefing-exit'));
      await ui(value => !value.exists && value.cameraSettled, 'comments-exit'); await afterGets('close-briefing', 0);
    }
  };
  const selectRoom = async room => {
    await exitPanel();
    await beforeGets('select-room');
    await select(nativeHarness, { id: room.clientThreadId, title: room.title, wireClientThreadId: room.clientThreadId });
    expectedRoom = room;
    const value = await ui(value => value.activeThreadId === room.clientThreadId && value.cameraSettled, 'comments-room-selected');
    await afterGets('select-room', 0); return value;
  };
  const open = async room => {
    await exitPanel();
    if ((await ui()).activeThreadId !== room.clientThreadId) await selectRoom(room);
    await beforeGets('open-briefing');
    await native(hook('briefing-open') + attributeSelector('data-answer-id', room.answerId));
    const value = await ui(value => value.exists && value.briefingId === room.briefing.id && value.stepId === room.briefing.steps[0].id
      && !value.preparing && value.cameraSettled && value.listState === 'ready', 'comments-open-ready');
    draft(value, room); await afterGets('open-briefing', 1, room); return value;
  };
  const sourceHashes = Object.fromEntries(a.sources.map(source => [source.sourceId, source.captureHash]));
  await selectRoom(a); // Native history loading is not implied by an active seeded room id.
  let shown = await open(a);
  const briefing = { ...a.briefing, title: shown.title }; // title is presentation only; saved body is independently hashed below.
  const nonce = randomBytes(4).toString('hex');
  const enter = async text => {
    await beforeGets('edit-comment'); await ensure(hook('briefing-comment'), 'control');
    await replace(nativeHarness, hook('briefing-comment'), text); await afterGets('edit-comment', 0);
  };
  const commit = async (clientRequestId, text, expectedPosts, terminal = 'finished') => {
    assert.ok(commentUuid(clientRequestId));
    const value = await wait(state, value => receipts(value).some(row => row.method === 'POST'
      && row.clientRequestId === clientRequestId && Number.isFinite(row.committedAt) && row.terminalCause === terminal),
    { label: 'comment-actual-store-commit', phase: 'comments-store' });
    const matches = receipts(value).filter(row => row.method === 'POST' && row.clientRequestId === clientRequestId);
    assert.equal(matches.length, 1, 'No automatic comment POST retry'); assert.equal(postCount(value), expectedPosts);
    const receipt = matches[0]; assert.deepEqual(receipt.R, briefingRoute(a)); assert.equal(receipt.responseStatus, 201);
    assertBriefingCommentReceipt(receipt, { account: seed.account.variant, epoch: capturedEpoch, route: briefingRoute(a), terminal });
    assert.ok(commentUuid(receipt.requestId) && receipt.committedAt >= receipt.receivedAt);
    const stored = rows(value, a).filter(row => row.clientRequestId === clientRequestId);
    assert.equal(stored.length, 1); const saved = stored[0];
    assert.equal(saved.id, receipt.commentId); assert.equal(saved.seq, receipt.seq); assert.equal(saved.storedHash, receipt.storedHash);
    assert.equal(saved.textHash, fingerprintQaBytes(text).sha256, 'Actual stored comment body differs from native input');
    assert.equal(saved.stepId, step.id); assert.deepEqual([...saved.sourceIds].sort(), [...step.sourceIds].sort());
    result.comments.push({ id: saved.id, clientRequestId, seq: saved.seq, storedHash: saved.storedHash, textHash: saved.textHash });
    assert.ok(result.comments.length <= 4);
    return { receipt: structuredClone(receipt), stored: saved, state: value,
      expectedSaved: { ...saved, text, conversationId: a.conversationId, stepIndex: 0 } };
  };
  const proveRow = async (value, committed, included) => {
    let paintedStatus = null;
    if (value.status !== 'idle') {
      paintedStatus = await ensure(hook('briefing-comment-status'), 'status');
      assertBriefingPanelInvariant(value, paintedStatus, { sameTarget: false });
      assert.equal(paintedStatus.statusReadable, true);
      assert.ok(result.statusProofs.length < 12);
      result.statusProofs.push({ observedAt: paintedStatus.observedAt, activeThreadId: paintedStatus.activeThreadId,
        briefingId: paintedStatus.briefingId, stepId: paintedStatus.stepId, clientRequestId: paintedStatus.clientRequestId,
        state: paintedStatus.status, evidence: paintedStatus.statusEvidence });
    }
    const reached = await ensure(hook('briefing-comment-row') + attributeSelector('data-comment-id', committed.stored.id), 'row', committed.stored.id);
    assertBriefingPanelInvariant(paintedStatus || value, reached, { sameTarget: false }); value = reached;
    assert.equal(value.activeThreadId, a.clientThreadId); assert.equal(value.briefingId, a.briefing.id); assert.equal(value.stepId, step.id);
    assert.ok(value.rowCount <= 8 && value.rows.length === value.rowCount, 'Bounded complete visible-row observation required');
    const matches = value.rows.filter(row => row.id === committed.stored.id); assert.equal(matches.length, 1);
    const row = matches[0]; assert.equal(row.seq, committed.stored.seq); assert.equal(row.stepId, step.id);
    assert.equal(row.clientRequestId, committed.stored.clientRequestId); assert.equal(row.text, committed.expectedSaved.text);
    assert.equal(row.included, included); assert.equal(row.readable, true);
    assert.ok(row.target); assert.match(row.draftStatus, included ? /포함됨.*전송하지 않음/ : /초안에 포함하지 않음/);
    return value; // Status and this exact row were painted in separate observations.
  };
  const includeProof = (prior, value, saved) => assertBriefingCommentDraft(prior, draft(value, a), { briefing, saved: saved.expectedSaved, sourceHashes });
  const firstText = `QA saved comment ${nonce}`;
  await enter(firstText); await beforeGets('normal-save'); await native(hook('briefing-comment-attach'));
  shown = await ui(value => value.status === 'included' && commentUuid(value.clientRequestId), 'comment-saved-and-included');
  const first = await commit(shown.clientRequestId, firstText, 1);
  auditGets(first.state, 0, 'normal-save:after');
  shown = await proveRow(shown, first, true); includeProof(initialDrafts.get(a.clientThreadId), shown, first);
  const firstDraft = draft(shown, a); check('one native save persists one exact comment and appends without replacing existing draft/attachments', true);
  await beforeGets('same-comment-include'); await native(hook('briefing-comment-attach'));
  shown = await ui(value => value.status === 'included', 'same-comment-reincluded'); await afterGets('same-comment-include', 0);
  includeProof(firstDraft, shown, first); assert.equal(postCount(await state()), 1);
  check('same saved comment is not duplicated in the draft and is not posted again', true);
  shown = await open(a); shown = await proveRow(shown, first, true); assert.deepEqual(draft(shown, a), firstDraft);
  assert.deepEqual(rows(await state(), a), rows(first.state, a));
  check('native close/reopen restores the exact saved comment row and included state', true);
  await capture('comments-saved-reopened');

  const arm = async (mode, expectedPosts, extra = {}) => {
    await beforeGets('arm-comment-control');
    const body = { ...briefingRoute(a), mode, bindNextPost: true,
      ...(mode === 'hold' ? { deadlineAt: Math.min(deadlineMs, Date.now() + 9000) } : {}), ...extra };
    const armed = await request('/__qa/briefing-comments/config', { method: 'POST', body });
    assert.ok(armed.ok && commentUuid(armed.holdId)); assert.equal(armed.requestId, null); assert.equal(armed.clientRequestId, null);
    const configured = await state(); assert.equal(postCount(configured), expectedPosts);
    auditGets(configured, 0, 'arm-comment-control:after');
    const placeholders = receipts(configured).filter(row => row.holdId === armed.holdId);
    assert.equal(placeholders.length, 1); assert.deepEqual(placeholders[0].R, briefingRoute(a));
    assert.equal(placeholders[0].receivedAt, null); assert.equal(placeholders[0].requestId, null);
    return { ...armed, deadlineAt: body.deadlineAt };
  };
  const lostArm = await arm('committed-response-lost', 1), lostText = `QA response lost ${nonce}`;
  await enter(lostText); await beforeGets('automatic-GET-recovery'); await native(hook('briefing-comment-attach'));
  shown = await ui(value => value.status === 'saved' && value.listState === 'ready', 'comment-auto-get-recovered');
  const lost = await commit(shown.clientRequestId, lostText, 2, 'committed-response-lost');
  assert.equal(lost.receipt.holdId, lostArm.holdId); assert.equal(lost.receipt.terminalCause, 'committed-response-lost');
  assert.equal(lost.receipt.writeAttempted, true); assert.equal(lost.receipt.finishAt, null);
  const recoveryBefore = structuredClone(getCheckpoint);
  const recoveredState = await afterGets('automatic-GET-recovery', 1, a, { parent: lost.receipt });
  const [recovered] = assertBriefingCommentGetDelta(recoveryBefore, receipts(recoveredState),
    { count: 1, route: briefingRoute(a), account: seed.account.variant, epoch: capturedEpoch, parent: lost.receipt });
  assert.deepEqual(recovered.listed.filter(row => row.clientRequestId === lost.stored.clientRequestId),
    [{ id: lost.stored.id, clientRequestId: lost.stored.clientRequestId, seq: lost.stored.seq }]);
  assert.equal(postCount(recoveredState), 2);
  shown = await proveRow(shown, lost, false); assert.deepEqual(draft(shown, a), firstDraft);
  check('committed lost POST is recovered by one production GET with the exact UUID; no rePOST or automatic draft inclusion', true);
  await beforeGets('recovered-row-include'); await native(hook('briefing-comment-include') + attributeSelector('data-comment-id', lost.stored.id));
  shown = await ui(value => value.status === 'included', 'recovered-comment-native-include');
  await afterGets('recovered-row-include', 0);
  shown = await proveRow(shown, lost, true); includeProof(firstDraft, shown, lost);
  const afterLost = draft(shown, a); assert.equal(postCount(await state()), 2);
  check('recovered saved comment enters the preserved draft only through its native row button', true);

  const held = await arm('hold', 2), lateText = `QA late room comment ${nonce}`;
  await enter(lateText); await beforeGets('held-save'); await native(hook('briefing-comment-attach'));
  shown = await ui(value => value.status === 'saving' && commentUuid(value.clientRequestId), 'comment-held-saving');
  const late = await commit(shown.clientRequestId, lateText, 3, null); auditGets(late.state, 0, 'held-save:after');
  assert.equal(late.receipt.holdId, held.holdId); assert.equal(late.receipt.terminalCause, null); assert.equal(late.receipt.writeAttempted, false);
  assert.deepEqual(draft(shown, a), afterLost);
  const switchAt = Date.now(); await selectRoom(b);
  const switched = await ui(value => !value.exists && value.activeThreadId === b.clientThreadId, 'comment-other-room');
  assert.deepEqual(draft(switched, b), initialDrafts.get(b.clientThreadId));
  assertBeforeDeadline(held.deadlineAt);
  await beforeGets('held-release');
  assertBeforeDeadline(held.deadlineAt);
  const release = await request('/__qa/briefing-comments/release', { method: 'POST', includeHttpStatus: true,
    body: { ...briefingRoute(a), holdId: held.holdId, requestId: late.receipt.requestId, clientRequestId: late.receipt.clientRequestId } });
  const terminalState = await wait(state, value => value.briefingComments.receipts.some(row => row.requestId === late.receipt.requestId && row.terminalCause),
    { label: 'comment-held-terminal', phase: 'comments-late', timeoutMs: Math.max(1, Math.min(3000, held.deadlineAt - Date.now())) });
  const terminal = receipts(terminalState).find(row => row.requestId === late.receipt.requestId);
  auditGets(terminalState, 0, 'held-release:after');
  for (const key of ['requestId', 'clientRequestId', 'holdId', 'R', 'account', 'epoch', 'commentId', 'seq', 'storedHash', 'committedAt']) {
    assert.deepEqual(terminal[key], late.receipt[key]); assert.deepEqual(release.body.receipt[key], late.receipt[key]);
  }
  assert.equal(terminal.releaseAttempts, 1); assert.ok(terminal.releaseAttemptAt >= switchAt);
  if (terminal.terminalCause === 'peer-close-before-finish') {
    assert.equal(release.httpStatus, 409); assert.equal(release.body.code, 'QA_COMMENT_ALREADY_CLOSED');
    assert.equal(terminal.writeAttempted, false); assert.equal(terminal.finishAt, null);
    assert.equal(terminal.writableFinishedAtClose, false); assert.ok(terminal.closeAt >= switchAt);
  } else {
    assert.equal(terminal.terminalCause, 'finished'); assert.equal(release.httpStatus, 200);
    assert.equal(terminal.writeAttempted, true); assert.equal(terminal.responseStatus, 201); assert.ok(terminal.finishAt >= terminal.releaseAttemptAt);
  }
  result.lateTransport = { classification: terminal.terminalCause === 'finished' ? 'serverResponseFinished' : 'transportAborted',
    terminal: structuredClone(terminal), uiCallbackDeliveryProven: false };
  result.lateSafety = await observeContextUnchanged(read, value => {
    assert.equal(value.activeThreadId, b.clientThreadId); assert.equal(value.exists, false);
    assert.deepEqual(draft(value, b), initialDrafts.get(b.clientThreadId)); assert.deepEqual(draft(value, a), afterLost);
  }, deadlineMs, { diagnostics, label: 'comment-late-other-room-unchanged' });
  check('exact terminal receipt plus fresh observations show no late injection into either draft or the other room', true);
  await capture('comments-late-other-room');
  const final = await state(); assert.equal(postCount(final), 3); assert.equal(rows(final, a).length, 3); assert.equal(rows(final, b).length, 0);
  auditGets(final, 0, 'late-observation-and-capture:after');
  for (const room of seed.identities) assert.deepEqual(await readStored(room), captures.get(room.clientThreadId));
  assert.deepEqual(runtime(final), runtime(initial)); result.runtime = runtime(final);
  check('all three native saves remain scoped actual records; immutable capture/payload and zero provider/send counts are preserved', true);

  // Separate sixth case: a human-triggered replay is not an automatic POST
  // retry. Both lost responses have exact production receipts before the click.
  shown = await open(a); assert.deepEqual(draft(shown, a), afterLost);
  const retryArm = await arm('committed-response-lost', 3, { recoveryGetResponseLostOnce: true });
  const originalText = `QA original retry opinion ${nonce}`, editedText = `QA different unsaved opinion ${nonce}`;
  await enter(originalText); await beforeGets('lost-recovery-GET'); await native(hook('briefing-comment-attach'));
  shown = await ui(value => value.status === 'unknown' && value.listState === 'failed', 'comment-recovery-get-lost');
  const uncertain = await commit(shown.clientRequestId, originalText, 4, 'committed-response-lost');
  assert.equal(uncertain.receipt.holdId, retryArm.holdId); assert.equal(uncertain.receipt.terminalCause, 'committed-response-lost');
  assert.equal(uncertain.receipt.writeAttempted, true); assert.equal(uncertain.receipt.finishAt, null);
  const failedBefore = structuredClone(getCheckpoint);
  const failedState = await afterGets('lost-recovery-GET', 1, a, { terminal: 'recovery-get-response-lost', parent: uncertain.receipt });
  const [failedGet] = assertBriefingCommentGetDelta(failedBefore, receipts(failedState), { count: 1, route: briefingRoute(a),
    account: seed.account.variant, epoch: capturedEpoch, terminal: 'recovery-get-response-lost', parent: uncertain.receipt });
  assert.deepEqual(failedGet.recoveryOf, { holdId: retryArm.holdId, requestId: uncertain.receipt.requestId,
    clientRequestId: uncertain.stored.clientRequestId });
  assert.equal(failedGet.terminalCause, 'recovery-get-response-lost'); assert.equal(failedGet.responseStatus, 200);
  assert.equal(failedGet.writeAttempted, true); assert.equal(failedGet.finishAt, null);
  assert.ok(failedGet.receivedAt >= uncertain.receipt.committedAt && failedGet.readCompletedAt >= failedGet.receivedAt);
  assert.deepEqual(failedGet.listed.filter(row => row.clientRequestId === uncertain.stored.clientRequestId),
    [{ id: uncertain.stored.id, clientRequestId: uncertain.stored.clientRequestId, seq: uncertain.stored.seq }]);
  await enter(editedText);
  await ensure(hook('briefing-comment-status'), 'status');
  const unchangedAttempt = value => {
    assert.equal(value.activeThreadId, a.clientThreadId); assert.equal(value.briefingId, a.briefing.id); assert.equal(value.stepId, step.id);
    assert.equal(value.status, 'unknown'); assert.equal(value.listState, 'failed'); assert.equal(value.statusReadable, true);
    assert.equal(value.clientRequestId, uncertain.stored.clientRequestId); assert.equal(value.inputText, editedText);
    assert.equal(value.originalText, originalText); assert.equal(value.originalReadable, true); assert.equal(value.retryEnabled, true);
    assert.equal(value.retryClientRequestId, uncertain.stored.clientRequestId); assert.deepEqual(draft(value, a), afterLost);
    assert.equal(value.rows.some(row => row.id === uncertain.stored.id), false, 'Lost GET must not masquerade as UI recovery');
  };
  result.beforeManualRetry = await observeContextUnchanged(read, unchangedAttempt, deadlineMs,
    { diagnostics, label: 'comment-unconfirmed-edited-input-preserved' });
  const beforeRetry = await state(); assert.equal(postCount(beforeRetry), 4);
  auditGets(beforeRetry, 0, 'unconfirmed-observation:after');
  assert.deepEqual(rows(beforeRetry, a), rows(uncertain.state, a));
  check('actual POST plus recovery GET response loss retains the original UUID/body and new edited input without automatic POST', true);
  await beforeGets('manual-retry'); const manualClickAt = Date.now(); await native(hook('briefing-comment-retry'));
  shown = await ui(value => value.status === 'saved' && value.clientRequestId === uncertain.stored.clientRequestId,
    'comment-explicit-same-uuid-retry-saved');
  const retryState = await wait(state, value => value.briefingComments.receipts.some(row => row.method === 'POST'
    && row.clientRequestId === uncertain.stored.clientRequestId && row.requestId !== uncertain.receipt.requestId && row.terminalCause === 'finished'),
  { label: 'comment-explicit-retry-finished', phase: 'comments-store', timeoutMs: 2000 });
  assert.equal(postCount(retryState), 5);
  auditGets(retryState, 0, 'manual-retry:after');
  const attempts = receipts(retryState).filter(row => row.method === 'POST' && row.clientRequestId === uncertain.stored.clientRequestId);
  assert.equal(attempts.length, 2); const manual = attempts.find(row => row.requestId !== uncertain.receipt.requestId);
  assert.ok(manual.receivedAt >= manualClickAt && manual.committedAt >= manual.receivedAt && manual.finishAt >= manual.committedAt);
  assert.equal(manual.responseStatus, 201); assert.equal(manual.writeAttempted, true); assert.deepEqual(manual.R, uncertain.receipt.R);
  for (const key of ['clientRequestId', 'commentId', 'seq', 'storedHash']) assert.equal(manual[key], uncertain.receipt[key]);
  assert.deepEqual(rows(retryState, a), rows(beforeRetry, a), 'Explicit replay must not add or rewrite a stored comment');
  shown = await proveRow(shown, uncertain, false); assert.equal(shown.inputText, editedText); assert.deepEqual(draft(shown, a), afterLost);
  result.manualRetry = { clientRequestId: uncertain.stored.clientRequestId, commentId: uncertain.stored.id, seq: uncertain.stored.seq,
    manualClickAt, requestIds: attempts.map(row => row.requestId), receivedPosts: 2, storedComments: 1,
    originalTextHash: uncertain.stored.textHash, editedInputHash: fingerprintQaBytes(shown.inputText).sha256 };
  check('one explicit retry reuses the exact UUID/id/seq and original stored body; edited input and draft remain untouched', true);
  await beforeGets('manual-recovered-row-include'); await native(hook('briefing-comment-include') + attributeSelector('data-comment-id', uncertain.stored.id));
  shown = await ui(value => value.status === 'included', 'manually-recovered-comment-native-include');
  await afterGets('manual-recovered-row-include', 0);
  shown = await proveRow(shown, uncertain, true); includeProof(afterLost, shown, uncertain); assert.equal(shown.inputText, editedText);
  assert.deepEqual(draft(shown, b), initialDrafts.get(b.clientThreadId));
  const completed = await state(); assert.equal(postCount(completed), 5);
  auditGets(completed, 0, 'final-store:after');
  assert.equal(rows(completed, a).length, 4); assert.equal(rows(completed, b).length, 0);
  for (const saved of [first, lost, late]) assert.equal(receipts(completed)
    .filter(row => row.method === 'POST' && row.clientRequestId === saved.stored.clientRequestId).length, 1);
  for (const room of seed.identities) assert.deepEqual(await readStored(room), captures.get(room.clientThreadId));
  assert.deepEqual(runtime(completed), runtime(initial)); result.runtime = runtime(completed);
  check('manual recovery adds only its original saved opinion through the row button; all immutable attachments and zero-send counts remain intact', true);
  await capture('comments-explicit-retry-included');
  auditGets(await state(), 0, 'final-capture:after');
}

export async function runBriefingComments(options,
  { env = process.env, createHarness = options => new FirefoxMcpChatHarness(options), scenario = verifyBriefingComments } = {}) {
  const { profile } = options, deadlineMs = Math.min(options.deadlineMs, Date.now() + 360000);
  assertContextQaEnvironment(env); assertBeforeDeadline(deadlineMs); assert.equal(options.phase, 'comments');
  assert.equal(env.EGDESK_QA_BRIEFING_COMMENTS_SEED, '1'); assert.notEqual(env.EGDESK_QA_CONTEXT_SOURCE_CHANGE_SEED, '1');
  assertQaFixtureManifest(profile); const isolation = assertQaProfileBridge(profile, env);
  const result = { kind: 'briefing-comments-fixture-native', phase: 'comments', deadlineMs, automatedAssertionsPassed: false,
    nativeInputs: true, domInjection: false, providerTurn: 'fixture-only-no-native-provider', checks: [], screenshots: [], visualReview: 'pending',
    diagnostics: { total: 0, dropped: 0, records: [] } };
  let harness, eligible = false;
  try {
    harness = guardContextHarness(createHarness({ profile, marionettePort: 2829 }), deadlineMs, { diagnostics: result.diagnostics });
    result.fixtureIsolation = isolation; result.profileSources = qaProfileSourceFingerprints(profile);
    await readContextBeforeDeadline(() => harness.connect(), deadlineMs, { timeoutMs: 10000 });
    const guard = await observeGuard(harness);
    assert.ok(guard.headless && guard.mounted && guard.documentURI === 'chrome://browser/content/browser.xhtml');
    const request = (route, options) => contextQaJson(route, deadlineMs, { ...options, env });
    const initial = await request('/__qa/state'); assert.ok(initial.fixture && initial.profile === profile); eligible = true;
    await scenario({ harness, deadlineMs, initial, request, result,
      check(label, condition) { result.checks.push({ label, passed: !!condition }); assert.ok(condition, label); },
      async capture(name) { assertBeforeDeadline(deadlineMs); const file = await harness.screenshot(name, { allowHeadlessChromeFallback: true, deadlineMs });
        assertBeforeDeadline(deadlineMs); result.screenshots.push(file); } });
    assertBeforeDeadline(deadlineMs); result.automatedAssertionsPassed = true;
  } catch (error) {
    await recordBriefingFailureState(error, result, deadlineMs, { eligible, profile, env });
    await recordContextFailure(harness, error, result, deadlineMs, { eligible, screenshotName: 'comments-failure' });
  }
  finally {
    try { await harness?.close(); } catch (error) { result.cleanupError = shortError(error); result.automatedAssertionsPassed = false; }
    if (harness?.evidenceDir) { result.evidenceFile = path.join(harness.evidenceDir, 'result.json');
      fs.writeFileSync(result.evidenceFile, `${JSON.stringify(result, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  }
  return result;
}

// Legacy preparation is retained, not claimed as native CTX04 acceptance.
export async function runLegacyContextBriefing({ profile, deadlineMs, phase }, { env = process.env, run = runUiFlow } = {}) {
  assertContextQaEnvironment(env); assertBeforeDeadline(deadlineMs);
  assert.ok(['core', 'restored-range'].includes(phase), 'Legacy phase must be explicit');
  const token = env.EGDESK_QA_FIXTURE_TOKEN;
  const control = (route, body) => { assertBeforeDeadline(deadlineMs); return loopbackJson(route, { method: 'POST', body, token, env }); };
  const fixtureState = () => { assertBeforeDeadline(deadlineMs); return loopbackJson('/__qa/state', { token, env }); };
  return run(`context-briefing-fixture-${phase}`, async ({ harness, check, capture, result }) => {
  assertBeforeDeadline(deadlineMs);
  assert.equal(harness.profile, profile, 'Context QA must attach to the requested exact profile');
  result.phase = phase; result.deadlineMs = deadlineMs;
  result.legacySetup = phase === 'core' ? ['card creation/layout', 'Board save', 'thread title', 'temporary error listener'] : [];
  result.providerTurn = 'fixture-only-no-native-provider';
  result.actions = [];
  const manifest = assertQaFixtureManifest(harness.profile);
  const health = await loopbackJson('/health');
  const initial = await fixtureState();
  check('explicit fixture transport is bound to this exact guarded profile', health.fixture === true && initial.profile === harness.profile);
  check('core input APIs are integrated before any UI test action', await chrome(harness, () =>
    !!window.__egdesk?.codexBridge?.captureInputs && !!window.__egdesk.codexBridge.readInput));
  const checkpoint = path.join(manifest.root, 'context-qa-resume.json');

  // Never retry a click. A tool acknowledgement timeout is recorded separately;
  // progress requires the unique observed postcondition of that one action.
  const clickThen = async (label, selector, read, accept) => {
    await visible(harness, selector);
    let acknowledgement = 'received';
    try { await harness.click(selector); }
    catch (error) {
      if (!/MCP tools\/call timed out/.test(error.message)) throw error;
      acknowledgement = 'timeout; action not retried';
    }
    const observed = await waitUntil(read, accept);
    result.actions.push({ label, acknowledgement, postconditionObserved: true });
    return observed;
  };
  const panel = () => chrome(harness, () => {
    const root = document.getElementById('egd-codex-input-panel');
    const article = root?.querySelector('[data-testid="chat-input-snapshot"]');
    return { exists: !!root, sourceId: article?.dataset.snapshotId || null,
      sourceText: article?.querySelector('[aria-label="당시 캡처 본문"]')?.textContent || '',
      sourceLabel: !!article?.querySelector('[data-testid="chat-input-source-label"]'),
      packetId: article?.querySelector('[data-testid="chat-input-delivery"]')?.dataset.packetId || null };
  });
  const closePanel = () => clickThen('Close inspector', '[aria-label="첨부 패널 닫기"]', panel, value => !value.exists);
  const roomState = () => chrome(harness, () => {
    const c = window.__egdesk.state.codex;
    const t = c.threads.find(item => item.id === c.activeThreadId);
    return { id: t?.id, sources: t?.inputSources || [], draft: c.threadDrafts[t?.id] || '',
      preparing: !!t?.preparingInput, error: t?.sendError || null, briefingInputs: t?.briefingInputs || [] };
  });

  if (phase === 'restored-range') {
    observeQaFixtureFile(harness.profile, checkpoint);
    const saved = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
    if (saved.profile !== harness.profile || saved.kind !== 'egdesk-context-qa-restart-v1') throw new Error('Checkpoint is not bound to this profile');
    const before = await fixtureState();
    const target = await chrome(harness, sourceId => {
      const card = [...document.querySelectorAll('.egd-input-evidence-card')].find(node =>
        node._inputReference?.sourceId === sourceId && node._inputReference?.presentationRange?.startLine === 201);
      return card && { id: card.id, reference: card._inputReference, loaded: !!card._inputEvidenceLoaded };
    }, saved.rangeSourceId);
    check('restored card retains its immutable 201–240 reference',
      target?.reference?.presentationRange?.startLine === 201 && target.reference.presentationRange.endLine === 240);
    if (await chrome(harness, () => window.__egdesk.state.hudOpen)) {
      await clickThen('Close the overlapping side panel', '#egd-hud .egd-hud-close',
        () => chrome(harness, () => window.__egdesk.state.hudOpen), value => !value);
    }
    // Normal native viewport navigation, never an API camera adjustment.
    await harness.press('Control+0');
    if (!target.loaded) await clickThen('Load the restored evidence range', `${selectorForId(target.id)} [aria-label="저장된 당시 입력 불러오기"]`,
      () => chrome(harness, id => !!document.getElementById(id)?._inputEvidenceLoaded, target.id), Boolean);
    const text = await chrome(harness, id => document.getElementById(id)?.querySelector('[aria-label="당시 캡처 본문"]')?.textContent || '', target.id);
    check('restored range renders actual lines 201–240, not a relabeled first page', text === saved.rangeText);
    const after = await fixtureState();
    const relevant = after.context.inspectorReads.filter(item => item.sourceId === saved.rangeSourceId);
    check('the observed GET requested the saved actual range', relevant.at(-1)?.startLine === 201 && relevant.at(-1)?.endLine === 240);
    const pastPacket = captureContextReadEvidence(await loopbackJson(
      `/context/captures/${saved.packetSourceId}?packetId=${encodeURIComponent(saved.packetId)}`));
    assertStoredAgentDelivery(pastPacket.delivered, { packetId: saved.packetId,
      binding: saved.fixtureIdentity, expectedToolText: saved.packetText });
    await selectQaThread(harness, saved.thread);
    await clickThen('Open restored input history', hook('chat-activity-open'),
      () => harness.inspect(hook('chat-input-history')), value => value.length > 0);
    const history = hook('chat-input-history') + attributeSelector('data-run-id', saved.fixtureIdentity.runId);
    await harness.click(`${history} summary`);
    await clickThen('Inspect the restored historical input',
      `${history} ${hook('chat-input-history-open')}${attributeSelector('data-snapshot-id', saved.packetSourceId)}`,
      panel, value => value.sourceId === saved.packetSourceId && value.sourceText === saved.packetSourceText
        && value.packetId === saved.packetId);
    await harness.click(`#egd-codex-input-panel ${hook('chat-input-delivery')} > summary`);
    const renderedPacket = await chrome(harness, () =>
      document.querySelector('#egd-codex-input-panel [aria-label="실제로 전달된 payload 원문"]')?.textContent);
    check('restored history renders the exact past packet, not a new projection', renderedPacket === saved.packetText);
    const finalState = await fixtureState();
    check('restoration created no capture or send', finalState.context.captureBatches === before.context.captureBatches
      && finalState.observed.sends.length === before.observed.sends.length);
    await capture('restored-evidence-201-240-and-past-packet');
    return;
  }

  check('full core flow begins on a fresh fixture with zero sends/captures', initial.observed.sends.length === 0 && initial.context.captureBatches === 0);
  if (await chrome(harness, () => window.__egdesk.surface.snapshot().mode === 'browser')) {
    await clickThen('Enter Desk', '#egd-desk-entry', () => chrome(harness, () => window.__egdesk.surface.snapshot().mode), value => value === 'desk');
  }
  const nonce = randomBytes(5).toString('hex');
  const originalLines = Array.from({ length: 610 }, (_, index) => `QA_FILE_V0_${nonce}_line_${index + 1}`);
  const changedLines = Array.from({ length: 610 }, (_, index) => `QA_FILE_V1_${nonce}_line_${index + 1}`);
  const sourceFile = path.join(manifest.root, `context-source-${nonce}.txt`);
  fs.writeFileSync(sourceFile, originalLines.join('\n'), { flag: 'wx', mode: 0o600 });
  const browserFile = path.join(manifest.root, `context-browser-${nonce}.html`);
  const browserText = Array.from({ length: 610 }, (_, index) => `QA_BROWSER_${nonce}_line_${index + 1}`).join('\n');
  fs.writeFileSync(browserFile, `<title>QA Browser ${nonce}</title><pre>${browserText}</pre>`, { flag: 'wx', mode: 0o600 });
  result.fixtureSource = sourceFile;
  const originalFile = observeQaFixtureFile(harness.profile, sourceFile);
  const scene = await chrome(harness, ({ fileUrl, nonce, browserUrl }) => {
    const api = window.__egdesk;
    // A short, fixture-only URL keeps the full 610-line content out of both
    // MCP's evaluation input and the source-location label in the picker.
    const file = api.cardRuntime.openBrowserCard(fileUrl, { openMode: 'new' });
    const browser = api.cardRuntime.openBrowserCard(browserUrl, { openMode: 'new' });
    const longText = Array.from({ length: 610 }, (_, index) => `QA_LONG_URL_${nonce}_line_${index + 1}`).join('\n');
    const longUrl = `data:text/html;charset=utf-8,${encodeURIComponent(`<title>QA long URL ${nonce}</title><pre>${longText}</pre>`)}`;
    const longBrowser = api.cardRuntime.openBrowserCard(longUrl, { openMode: 'new' });
    for (const [index, card] of [file, browser].entries()) {
      Object.assign(card.style, { left: `${160 + index * 720}px`, top: '160px', width: '640px', height: '420px' });
    }
    const boardId = `qa-context-board-${nonce}`, title = `QA context ${nonce}`;
    api.agenda.save({ agendaId: boardId, title, memberIds: [file.id, browser.id], contextBindings: [] });
    return { boardId, title, originalIds: [file.id, browser.id], longUrlViewId: longBrowser.id };
  }, { fileUrl: pathToFileURL(sourceFile).href, nonce, browserUrl: qaBridgeUrl(`/__qa/browser-document/${nonce}`, env) });
  const thread = await newQaThread(harness, `QA context ${nonce}`);
  await visible(harness, '.egd-chat-card .egd-chat-card-title');
  await chrome(harness, () => {
    window.__egdeskQaHeaderErrors = [];
    window.__egdeskQaHeaderListener = event => window.__egdeskQaHeaderErrors.push(String(event.message));
    window.addEventListener('error', window.__egdeskQaHeaderListener, true);
  });
  await harness.click('.egd-chat-card .egd-chat-card-title');
  const headerErrors = await chrome(harness, () => {
    window.removeEventListener('error', window.__egdeskQaHeaderListener, true);
    const errors = [...window.__egdeskQaHeaderErrors];
    delete window.__egdeskQaHeaderListener;
    delete window.__egdeskQaHeaderErrors;
    return errors;
  });
  check('native Chat card header click does not raise the missing pan helper error',
    !headerErrors.some(message => message.includes('startPanIfNeeded')));
  const moveToHud = (await harness.inspect('.egd-chat-card button[title="우측 패널로 이동"]'))[0];
  if (moveToHud?.visible) {
    await clickThen('Dock existing Chat in the side panel', '.egd-chat-card button[title="우측 패널로 이동"]',
      () => chrome(harness, () => window.__egdesk.state.codex.chatDockMode), value => value === 'hud');
    await selectQaThread(harness, thread);
  }
  await harness.click('[aria-label="Board 목록"]');
  await harness.fill('.egd-agenda-switch-search-input', scene.title);
  await clickThen('Open the saved QA Board', hook('board-open') + attributeSelector('data-board-id', scene.boardId),
    () => chrome(harness, id => Object.values(window.__egdesk.boards.projections().projections).find(item => item.boardId === id), scene.boardId), Boolean);
  const board = await chrome(harness, id => {
    const p = Object.values(window.__egdesk.boards.projections().projections).find(item => item.boardId === id);
    return { id: p.id, members: p.members.map(item => ({ sourceId: item.sourceId, viewId: item.viewId })) };
  }, scene.boardId);
  const fileView = board.members.find(item => item.sourceId === scene.originalIds[0]).viewId;
  const browserView = board.members.find(item => item.sourceId === scene.originalIds[1]).viewId;
  await clickThen('Open this Board actions menu', hook('board-menu') + attributeSelector('data-projection-id', board.id),
    () => harness.inspect(hook('board-attach-chat') + attributeSelector('data-projection-id', board.id)), nodes => nodes.some(node => node.visible));
  await clickThen('Attach this Board selection to the current Chat', hook('board-attach-chat') + attributeSelector('data-projection-id', board.id), panel, value => value.exists);
  const selected = await chrome(harness, () => [...document.querySelectorAll('[data-testid="chat-attach-source"]')].filter(node => node.checked).map(node => node.dataset.viewId).sort());
  check('Board attach selects only its two actual member views', JSON.stringify(selected) === JSON.stringify([fileView, browserView].sort()));
  const longSelector = hook('chat-attach-source') + attributeSelector('data-view-id', scene.longUrlViewId);
  const longRow = await chrome(harness, selector => {
    const input = document.querySelector(selector), row = input.closest('label'), rect = input.getBoundingClientRect();
    return { locationLength: row.querySelector('small').textContent.length, width: rect.width, height: rect.height,
      rowHeight: row.getBoundingClientRect().height, checked: input.checked };
  }, longSelector);
  result.longUrlRegression = longRow;
  check('20KB source location keeps an actual checkbox-sized control and bounded row', longRow.locationLength > 16000 && longRow.width >= 16 && longRow.height >= 16 && longRow.rowHeight < 200 && !longRow.checked);
  await clickThen('Select long-URL Browser through its actual checkbox', longSelector,
    () => chrome(harness, selector => document.querySelector(selector).checked, longSelector), Boolean);
  await clickThen('Deselect long-URL Browser without changing Board selection', longSelector,
    () => chrome(harness, selector => document.querySelector(selector).checked, longSelector), value => !value);
  await capture('long-url-checkbox-regression');
  await clickThen('Confirm selected attachments', hook('chat-attach-confirm'), roomState, value => value.sources.length === 2);
  let attached = await roomState();
  const fileInput = attached.sources.find(item => item.sourceRef.viewId === fileView);
  const browserInput = attached.sources.find(item => item.sourceRef.viewId === browserView);
  check('file and Browser references preserve their selected view identities', fileInput?.kind === 'file' && fileInput.sourceRef.path === sourceFile && browserInput?.kind === 'browser');
  const chip = id => hook('chat-attachment') + attributeSelector('data-source-id', id);
  await clickThen('Remove one attachment without replacing the other', `${chip(browserInput.id)} ${hook('chat-attachment-remove')}`, roomState, value => value.sources.length === 1);
  await clickThen('Open attachment picker', hook('chat-attach-open'), panel, value => value.exists);
  const choices = await chrome(harness, () => [...document.querySelectorAll('[data-testid="chat-attach-source"]')]
    .map(node => ({ viewId: node.dataset.viewId, checked: node.checked })));
  for (const choice of choices) {
    if (choice.checked !== (choice.viewId === browserView)) {
      await harness.click(hook('chat-attach-source') + attributeSelector('data-view-id', choice.viewId));
    }
  }
  await clickThen('Add the Browser back through its real checkbox', hook('chat-attach-confirm'), roomState, value => value.sources.length === 2);
  check('attachment selection alone creates no capture or send', (await fixtureState()).context.captureBatches === 0 && (await fixtureState()).observed.sends.length === 0);

  await clickThen('Preview the selected local file', `${chip(fileInput.id)} ${hook('chat-attachment-inspect')}`, panel, value => !!value.sourceId);
  const preview = await panel();
  const previewBefore = captureContextReadEvidence(await loopbackJson(`/context/captures/${preview.sourceId}`));
  check('preview labels captured source and does not invent model delivery', preview.sourceLabel && preview.packetId === null && previewBefore.delivered === null);
  check('first page renders the exact first 200 captured lines', preview.sourceText === originalLines.slice(0, 200).join('\n'));
  fs.writeFileSync(sourceFile, changedLines.join('\n'));
  const changedFile = observeQaFixtureFile(harness.profile, sourceFile);
  const batches = (await fixtureState()).context.captureBatches;
  await clickThen('Read the next captured page after changing the live original', hook('chat-input-next'), panel,
    value => value.sourceText === originalLines.slice(200, 400).join('\n'));
  await clickThen('Return to the prior captured page', hook('chat-input-previous'), panel,
    value => value.sourceText === originalLines.slice(0, 200).join('\n'));
  const previewAfter = captureContextReadEvidence(await loopbackJson(`/context/captures/${preview.sourceId}`));
  assertFrozenFileReadAfterMutation({ snapshotBefore: previewBefore, snapshotAfter: previewAfter,
    liveBefore: originalFile, liveAfter: changedFile, expectedSourceText: originalLines.slice(0, 200).join('\n') });
  check('inspector pagination never recaptures the changed live file', (await fixtureState()).context.captureBatches === batches);
  await capture('context-old-source-vs-changed-file');
  await closePanel();

  const draftA = `EGDESK_QA_CONTEXT ${nonce}`, draftB = `QA newer draft ${nonce}; do not send automatically`;
  await control('/__qa/context-config', { failNextCapture: true });
  await sendFromComposer(harness, draftA);
  const failed = await waitUntil(roomState, value => !value.preparing && !!value.error);
  check('failure came from the intentionally configured fixture response, not broken Browser capture', (await fixtureState()).observed.contextCaptureFailures === 1);
  check('capture failure retains exact draft and attachments with zero sends', failed.draft === draftA && failed.sources.length === 2 && (await fixtureState()).observed.sends.length === 0);
  await control('/__qa/context-config', { holdNextCapture: true });
  await sendFromComposer(harness, draftA); // Explicit human retry after definite capture failure.
  await waitUntil(fixtureState, value => value.pendingContextCaptures === 1);
  await harness.fill(hook('chat-composer'), draftB);
  check('newer draft B is present while send A awaits capture', (await roomState()).draft === draftB);
  await control('/__qa/context-release', { phase: 'capture', clientThreadId: thread.wireClientThreadId });
  const accepted = await waitUntil(fixtureState, value => value.observed.sends.length === 1 && value.observed.sends[0].respondedAt);
  const sent = accepted.observed.sends[0], run = accepted.runs.find(item => item.runId === sent.runId);
  result.fixtureIdentity = { conversationId: run.conversationId, runId: run.runId, answerId: run.answerId };
  assertContextSendBindings(sent, { clientThreadId: thread.wireClientThreadId, sourceIds: run.contextCaptures.map(item => item.sourceId) });
  check('delayed A sends once and never clears newer composer B', sent.message === draftA && (await roomState()).draft === draftB);
  const browserCapture = run.contextCaptures.find(item => item.sourceRef.viewId === browserView);
  const browserRead = captureContextReadEvidence(await loopbackJson(`/context/captures/${browserCapture.sourceId}`));
  check('Fission Browser capture contains the exact 610 loaded DOM lines from the selected view',
    browserCapture.sourceRef.url === qaBridgeUrl(`/__qa/browser-document/${nonce}`, env)
    && browserCapture.shape.lineCount === 610
    && browserCapture.hash === fingerprintQaBytes(browserText).sha256
    && browserRead.source.text === browserText.split('\n').slice(0, 200).join('\n'));
  const fileCapture = run.contextCaptures.find(item => item.sourceRef.path === sourceFile);
  const inputBefore = captureContextReadEvidence(await loopbackJson(`/context/captures/${fileCapture.sourceId}`));
  check('send-time capture records V1, not the older preview V0', fileCapture.hash === changedFile.sha256 && inputBefore.source.text === changedLines.slice(0, 200).join('\n'));
  fs.writeFileSync(sourceFile, `QA_LIVE_V2_${nonce}\n`);
  const liveV2 = observeQaFixtureFile(harness.profile, sourceFile);
  await control('/__qa/context-release', { runId: run.runId, phase: 'read' });
  const readState = await fixtureState();
  const delivery = readState.context.deliveries.find(item => item.sourceId === fileCapture.sourceId);
  const inputAfter = captureContextReadEvidence(await loopbackJson(`/context/captures/${fileCapture.sourceId}?packetId=${encodeURIComponent(delivery.packet.packetId)}`));
  assertFrozenFileReadAfterMutation({ snapshotBefore: inputBefore, snapshotAfter: inputAfter, liveBefore: changedFile,
    liveAfter: liveV2, expectedSourceText: changedLines.slice(0, 200).join('\n') });
  assertStoredAgentDelivery(inputAfter.delivered, { packetId: delivery.packet.packetId,
    binding: result.fixtureIdentity, expectedToolText: delivery.packet.text });
  check('fixture packet and captured source are distinct and explicitly fixture-only', delivery.fixtureOnly === true && inputAfter.source.text !== inputAfter.delivered.text);

  await clickThen('Open actual input history', hook('chat-activity-open'), () => harness.inspect(hook('chat-input-history')), value => value.length > 0);
  const history = hook('chat-input-history') + attributeSelector('data-run-id', run.runId);
  await harness.click(`${history} summary`);
  await clickThen('Inspect the bound historical input', `${history} ${hook('chat-input-history-open')}${attributeSelector('data-snapshot-id', fileCapture.sourceId)}`,
    panel, value => value.sourceId === fileCapture.sourceId && value.sourceText === changedLines.slice(0, 200).join('\n'));
  await harness.click(`#egd-codex-input-panel ${hook('chat-input-delivery')} > summary`);
  const packetText = await chrome(harness, () => document.querySelector('#egd-codex-input-panel [aria-label="실제로 전달된 payload 원문"]')?.textContent);
  check('history displays the exact stored packet separately from source text', packetText === delivery.packet.text && (await panel()).sourceLabel);
  await capture('context-source-and-exact-fixture-packet');
  await closePanel();
  await clickThen('Close activity panel', '[aria-label="활동 기록 닫기"]', () => harness.inspect(hook('chat-activity-panel')), value => value.length === 0);

  const previousCamera = await camera(harness);
  const evidenceBefore = (await harness.inspect('.egd-input-evidence-card')).length;
  await control('/__qa/context-release', { runId: run.runId, phase: 'briefing' });
  const completed = await waitUntil(fixtureState, value => value.runs.find(item => item.runId === run.runId)?.status === 'completed');
  const briefing = completed.runs.find(item => item.runId === run.runId).briefing;
  assertPublishedBriefing(briefing, { identity: result.fixtureIdentity, captures: run.contextCaptures });
  await visible(harness, hook('briefing-open'));
  check('publishing a Briefing does not auto-open cards or move the camera', (await harness.inspect('.egd-input-evidence-card')).length === evidenceBefore && sameCamera(previousCamera, await camera(harness)));
  const briefingState = () => chrome(harness, () => {
    const session = window.__egdesk.state.codex.briefingSession;
    if (!session) return null;
    const step = session.briefing.steps[session.index];
    const card = [...document.querySelectorAll('.egd-input-evidence-card')].find(node => node._inputReference?.sourceId === step.target.sourceId
      && node._inputReference?.presentationRange?.startLine === step.target.range?.startLine);
    const rect = card?.getBoundingClientRect(), panel = document.getElementById('egd-answer-briefing')?.getBoundingClientRect();
    const points = rect ? [[rect.left + 8, rect.top + 8], [rect.right - 8, rect.top + 8], [rect.left + rect.width / 2, rect.bottom - 8]] : [];
    return { stepId: step.id, preparing: !!session.preparing, loaded: !!card?._inputEvidenceLoaded,
      rect: rect && { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      fits: !!rect && rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= (panel?.top || window.innerHeight)
        && points.every(([x, y]) => card.contains(document.elementFromPoint(x, y))),
      retryButton: !!document.querySelector('[data-testid="briefing-show-evidence"]'),
      focused: document.activeElement?.getAttribute('data-testid') || document.activeElement?.getAttribute('aria-label') || null };
  });
  await clickThen('Open Briefing directly into its first fitted immutable target', hook('briefing-open') + attributeSelector('data-answer-id', run.answerId),
    briefingState, value => value && !value.preparing && value.loaded && value.fits);
  check('first step needs no extra show-evidence or Pan click', !(await briefingState()).retryButton);
  await capture('briefing-first-direct-fit');
  await clickThen('Next step fits its own immutable target directly', hook('briefing-next'), briefingState,
    value => value?.stepId === briefing.steps[1].id && value.loaded && value.fits);
  await capture('briefing-next-direct-fit');
  await clickThen('Previous returns directly to the first target', hook('briefing-previous'), briefingState,
    value => value?.stepId === briefing.steps[0].id && value.loaded && value.fits);
  const comment = `QA step comment ${nonce}`;
  await harness.fill(hook('briefing-comment'), comment);
  await clickThen('Copy this step comment to the existing newer Chat draft', hook('briefing-comment-attach'), roomState,
    value => value.draft.startsWith(draftB) && value.draft.includes(comment));
  const commented = await roomState();
  check('step comment retains immutable dependencies without sending or replacing newer input', commented.briefingInputs.some(item => item.sourceId === briefing.steps[0].target.sourceId)
    && (await fixtureState()).observed.sends.length === 1);
  await clickThen('Exit Briefing back to the previous view', hook('briefing-exit'),
    async () => ({ panel: await harness.inspect(hook('answer-briefing')), camera: await camera(harness) }), value => !value.panel.length && sameCamera(previousCamera, value.camera));
  await capture('briefing-return-and-unsent-step-comment');
  const second = briefing.steps[1].target;
  check('second Briefing step carries the explicit 201–240 restore range', second.range.startLine === 201 && second.range.endLine === 240);
  const rangeText = (await loopbackJson(`/context/captures/${second.sourceId}?startLine=201&endLine=240`)).source.text;
  check('real Briefing navigation materialized that exact evidence range', await chrome(harness, sourceId =>
    [...document.querySelectorAll('.egd-input-evidence-card')].some(card => card._inputReference?.sourceId === sourceId
      && card._inputReference?.presentationRange?.startLine === 201 && card._inputReference?.presentationRange?.endLine === 240), second.sourceId));
  await waitUntil(() => chrome(harness, sourceId => {
    const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
    const saved = JSON.parse(services.prefs.getStringPref('egdesk.deskSession.v1', '{}'));
    return (saved.cards || []).some(card => card.type === 'input-evidence'
      && card.runtimeState?.reference?.sourceId === sourceId
      && card.runtimeState.reference.presentationRange?.startLine === 201
      && card.runtimeState.reference.presentationRange?.endLine === 240);
  }, second.sourceId), Boolean);
  fs.writeFileSync(checkpoint, JSON.stringify({ kind: 'egdesk-context-qa-restart-v1', profile: harness.profile,
    thread, rangeSourceId: second.sourceId, rangeText, fixtureIdentity: result.fixtureIdentity,
    packetSourceId: fileCapture.sourceId, packetSourceText: changedLines.slice(0, 200).join('\n'),
    packetId: delivery.packet.packetId, packetText: delivery.packet.text }), { flag: 'wx', mode: 0o600 });
  result.restartCheck = { phase: 'restored-range', profile: harness.profile,
    instruction: 'Main may restart only this same disposable Firefox, keeping the explicit fixture server. Then run --phase restored-range.' };
  result.pendingLiveAcceptance = 'This script has not proven a native read/Reader/publishBriefing call. Use the separate coordinated Sol/max native stage.';
  });
}

export async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseContextQaCli(argv, (dependencies.now || Date.now)());
  assertContextQaEnvironment(dependencies.env || process.env);
  if (!['source-change', 'comments'].includes(options.phase)) return runLegacyContextBriefing(options, dependencies);
  const result = await (options.phase === 'comments' ? runBriefingComments : runContextSourceChange)(options, dependencies);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.automatedAssertionsPassed) process.exitCode = 1;
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
