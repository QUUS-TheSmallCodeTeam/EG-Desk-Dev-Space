import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import childProcess from 'node:child_process';
import { assertBriefingMultiSeed, assertBriefingCards, assertHeldCaptureReceipt, assertNoBriefingEffects,
  assertPreservedIntent, parseBriefingMultiCli, verifyBriefingMultiTarget } from './verify-firefox-mcp-briefing-multi-target.mjs';

const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const source = n => ({ sourceId: id(n), snapshotId: id(n), kind: 'file', captureHash: String(n).repeat(64) });
const a = { engineId: 'codex', engineProfileId: 'codex-default', clientThreadId: 'room-a', conversationId: 'conv-a',
  answerId: 'answer-a', title: 'A', sources: [source(1), source(2)],
  briefing: { id: id(3), steps: [{ id: 'first', sourceIds: [id(1), id(1), id(2)] }, { id: 'second', sourceIds: [id(1)] }] },
  preservation: { draftText: 'draft a', briefingInputs: [] } };
const b = { clientThreadId: 'room-b', conversationId: 'conv-b', title: 'B', sources: [source(4)], preservation: { draftText: 'draft b' } };
const seed = () => ({ version: 1, setupOnly: true, synthetic: true, ready: true, scenario: 'briefing-multi-target',
  account: { key: 'codex:fixture' }, identities: structuredClone([a, b]),
  counts: { runtimeAtSetup: { captureBatches: 0, fileCaptureOperations: 0, sends: 0, deliveries: 0 } } });
const lines = (prefix, start) => Array.from({ length: 4 }, (_, offset) => `${prefix}${start + offset}`).join('\n');
const cards = () => [
  { id: 'a1', sourceId: id(1), hash: source(1).captureHash, range: { startLine: 1, endLine: 4 }, loaded: true, text: lines('CTX04 synthetic file original line ', 1) },
  { id: 'a2', sourceId: id(1), hash: source(1).captureHash, range: { startLine: 5, endLine: 8 }, loaded: true, text: lines('CTX04 synthetic file original line ', 5) },
  { id: 'b1', sourceId: id(2), hash: source(2).captureHash, range: { startLine: 1, endLine: 4 }, loaded: true, text: lines('Briefing synthetic B original line ', 1) },
];
const effects = () => ({ briefingMultiTargetAttempts: { sendPosts: 0, capturePosts: 0, commentPosts: 0 },
  observed: { sends: [] }, context: { captureBatches: 0, fileCaptureOperations: 0, deliveries: [], inspectorReads: [] },
  briefingComments: { receipts: [], storeInspection: { count: 0 } } });
const noAction = () => assert.fail('import or invalid seed must not start browser, network, process or file writes');

test('multi-target verifier import is inert and CLI requires an exact future deadline and bounded scenario', async () => {
  const originals = { spawn: childProcess.spawn, listen: net.Server.prototype.listen, write: fs.writeFileSync, fetch: globalThis.fetch };
  try {
    childProcess.spawn = noAction; net.Server.prototype.listen = noAction; fs.writeFileSync = noAction; globalThis.fetch = noAction;
    await import(`./verify-firefox-mcp-briefing-multi-target.mjs?inert=${Date.now()}`);
  } finally { childProcess.spawn = originals.spawn; net.Server.prototype.listen = originals.listen; fs.writeFileSync = originals.write; globalThis.fetch = originals.fetch; }
  const now = Date.parse('2026-10-28T19:00:00Z'), args = ['--profile', '/explicit/profile', '--deadline-utc', '2026-10-28T22:00:00Z'];
  for (const scenario of ['complete', 'typing', 'pan', 'pan-aba', 'canvas-focus', 'step', 'room', 'account', 'close', 'retry', 'inspector']) {
    assert.equal(parseBriefingMultiCli([...args, '--scenario', scenario], now).scenario, scenario);
  }
  for (const bad of [[], args, [...args, '--scenario', 'other'], [...args, '--scenario', 'complete', '--profile', '/other'],
    ['--profile', 'relative', '--deadline-utc', args[3], '--scenario', 'complete'],
    ['--profile', '/x', '--deadline-utc', '2026-10-29T07:00:00+09:00', '--scenario', 'complete']]) {
    assert.throws(() => parseBriefingMultiCli(bad, now));
  }
  assert.throws(() => parseBriefingMultiCli([...args, '--scenario', 'complete'], Date.parse(args[3])), /future/);
});

test('multi-target seed validation rejects real, crossed, duplicated or differently shaped setup before UI input', async () => {
  assert.doesNotThrow(() => assertBriefingMultiSeed(seed()));
  for (const mutate of [s => { s.synthetic = false; }, s => { s.scenario = 'comments'; }, s => { s.identities[1].clientThreadId = 'room-a'; },
    s => { s.identities[0].sources[1].sourceId = id(1); }, s => { s.identities[0].briefing.steps[0].sourceIds.pop(); },
    s => { s.counts.runtimeAtSetup.sends = 1; }]) {
    const bad = seed(); mutate(bad); assert.throws(() => assertBriefingMultiSeed(bad));
    await assert.rejects(verifyBriefingMultiTarget({ harness: {}, deadlineMs: Date.now() + 1000,
      initial: { briefingCommentsSeed: bad }, request: noAction, check: noAction }, { select: noAction, click: noAction, observe: noAction }));
  }
});

test('card acceptance rejects wrong hash, merged ranges, duplicates, unloaded or live fallback text', () => {
  assert.doesNotThrow(() => assertBriefingCards({ cards: cards() }, a));
  for (const mutate of [c => { c[1].range = { startLine: 1, endLine: 8 }; }, c => { c[2].hash = source(1).captureHash; },
    c => { c[1] = structuredClone(c[0]); }, c => { c[0].loaded = false; }, c => { c.push(structuredClone(c[0])); },
    c => { c[0].text = 'QA changed live original'; }]) {
    const actual = cards(); mutate(actual); assert.throws(() => assertBriefingCards({ cards: actual }, a));
  }
});

test('held response requires the actual received request and exact account epoch, source and range', () => {
  const scope = { engineId: 'codex', engineProfileId: 'codex-default', clientThreadId: 'room-a', conversationId: 'conv-a',
    sourceId: id(1), startLine: 5, endLine: 8 };
  const receipt = { holdId: id(5), requestId: id(6), kind: 'capture-get', R: scope, account: 'a', epoch: 0,
    receivedAt: 100, deadlineAt: 1000, snapshotHash: 'f'.repeat(64), terminalCause: null, writeAttempted: false };
  assert.doesNotThrow(() => assertHeldCaptureReceipt(receipt, id(5), scope, 200));
  for (const patch of [{ requestId: null }, { account: 'b' }, { epoch: 1 }, { deadlineAt: 200 }, { snapshotHash: '' },
    { terminalCause: 'finished' }, { R: { ...scope, startLine: 1 } }, { R: { ...scope, conversationId: 'conv-b' } }]) {
    assert.throws(() => assertHeldCaptureReceipt({ ...receipt, ...patch }, id(5), scope, 200));
  }
  assert.throws(() => assertHeldCaptureReceipt(receipt, id(6), scope, 200));
});

test('intent and side-effect assertions reject focus, text, caret, selection, camera, send and save regressions', () => {
  const before = { camera: { target: { pan: { x: 1, y: 2 }, zoom: 1 } }, activeEntityId: 'a', selectionRevision: 1,
    focus: { tag: 'textarea', value: 'draft', start: 3, end: 3 }, draft: 'chat', attachments: [{ id: 'room', selected: ['source'] }], stepId: 'first' };
  assert.doesNotThrow(() => assertPreservedIntent(before, structuredClone(before)));
  for (const mutate of [v => { v.camera.target.pan.x++; }, v => { v.activeEntityId = 'b'; }, v => { v.selectionRevision++; },
    v => { v.focus.value = 'lost'; }, v => { v.focus.start = 1; }, v => { v.focus.tag = 'button'; }, v => { v.draft = ''; },
    v => { v.attachments[0].selected = []; }, v => { v.stepId = 'second'; }]) {
    const after = structuredClone(before); mutate(after); assert.throws(() => assertPreservedIntent(before, after));
  }
  assert.doesNotThrow(() => assertNoBriefingEffects(effects(), effects()));
  const observedLater = effects(); observedLater.briefingComments.storeInspection.readAt = 123;
  assert.doesNotThrow(() => assertNoBriefingEffects(effects(), observedLater), 'fresh read timestamp is not a store mutation');
  for (const mutate of [v => { v.briefingMultiTargetAttempts.sendPosts++; }, v => { v.briefingMultiTargetAttempts.capturePosts++; },
    v => { v.briefingMultiTargetAttempts.commentPosts++; }, v => { v.observed.sends.push({}); }, v => { v.context.captureBatches++; }, v => { v.context.fileCaptureOperations++; },
    v => { v.context.deliveries.push({}); }, v => { v.briefingComments.receipts.push({ method: 'POST', receivedAt: 1 }); },
    v => { v.briefingComments.storeInspection.count++; }]) {
    const after = effects(); mutate(after); assert.throws(() => assertNoBriefingEffects(effects(), after));
  }
});

test('complete model needs three exact UI cards, one GET per unique range and no legacy duplicate GET', async () => {
  async function model({ badRange = false, extraGet = false } = {}) {
    const initial = { ...effects(), briefingCommentsSeed: seed(), scenario: 'complete' }; let opened = false, next = false, checks = 0;
    const reads = [{ sourceId: id(1), startLine: 1, endLine: 4 }, { sourceId: id(1), startLine: 5, endLine: 8 },
      { sourceId: id(2), startLine: 1, endLine: 4 }];
    const request = async () => ({ ...effects(), context: { ...effects().context, inspectorReads: next && extraGet ? [...reads, reads[0]] : reads } });
    const observe = async () => { const visible = cards(); if (badRange) visible[1].range.endLine = 9;
      return { observedAt: Date.now(), activeThreadId: 'room-a', presentationId: opened ? 'presentation' : null,
        stepId: next ? 'second' : 'first', preparing: false, cards: opened ? visible : [], camera: { target: { pan: { x: opened ? 1 : 0, y: 0 }, zoom: 1 }, settled: true },
        activeEntityId: opened ? 'a1' : 'chat', draft: 'draft a', styleModes: ['author', 'user'] }; };
    await verifyBriefingMultiTarget({ harness: {}, deadlineMs: Date.now() + 2000, initial, request,
      check: (_, passed) => { assert.ok(passed); checks++; } }, { observe, select: async () => {},
      click: async (_h, selector) => { if (selector.includes('briefing-open')) opened = true; else if (selector.includes('briefing-next')) next = true; else noAction(); } });
    return checks;
  }
  assert.ok(await model() >= 4);
  await assert.rejects(model({ badRange: true })); await assert.rejects(model({ extraGet: true }));
});
