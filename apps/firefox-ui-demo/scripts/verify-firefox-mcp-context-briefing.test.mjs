import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import childProcess from 'node:child_process';
import vm from 'node:vm';
import { parseContextQaCli, assertContextQaEnvironment, readContextBeforeDeadline, waitContextBeforeDeadline,
  contextQaJson, guardContextHarness, observeContextSourceChange, observeContextControl, clickContextControl,
  assertSourceChangeSeed, verifyContextSourceChange, summarizeContextObservation, recordContextFailure, recordBriefingFailureState, runCli,
  assertBriefingCommentsSeed, observeBriefingComments, verifyBriefingComments, reachBriefingPanelTarget } from './verify-firefox-mcp-context-briefing.mjs';
import { fingerprintQaBytes } from './egdesk-context-qa-contract.mjs';

const ENV = { EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_STATE_FIXTURES: '1', EGDESK_QA_REAL_TURN: '0',
  EGDESK_QA_FIXTURE_TOKEN: 'context-fixture-unit-only', EGDESK_QA_FIXTURE_PORT: '39220' };
const noAction = () => assert.fail('no browser, provider, network, process or file mutation during import');

test('CTX04 verifier import is inert with no environment opt-in, CLI parsing or side effects', async () => {
  const originals = { spawn: childProcess.spawn, listen: net.Server.prototype.listen, write: fs.writeFileSync, fetch: globalThis.fetch };
  try {
    childProcess.spawn = noAction; net.Server.prototype.listen = noAction; fs.writeFileSync = noAction; globalThis.fetch = noAction;
    await import(`./verify-firefox-mcp-context-briefing.mjs?import-safety=${Date.now()}`);
  } finally {
    childProcess.spawn = originals.spawn; net.Server.prototype.listen = originals.listen;
    fs.writeFileSync = originals.write; globalThis.fetch = originals.fetch;
  }
});

test('CTX04 CLI requires exact future UTC deadline/profile and separates source-change from both retained legacy phases', async () => {
  const now = Date.parse('2026-10-26T18:00:00Z');
  const args = ['--profile', '/explicit/profile', '--deadline-utc', '2026-10-26T22:00:00Z'];
  for (const phase of ['core', 'restored-range', 'source-change', 'comments']) assert.deepEqual(parseContextQaCli([...args, '--phase', phase], now),
    { profile: '/explicit/profile', deadlineMs: Date.parse(args[3]), phase });
  assert.equal(parseContextQaCli(args, now).phase, 'core');
  for (const invalid of [[], args.slice(0, 2), [...args, '--phase', 'guessed'], [...args, '--profile', 'another'],
    [...args, '--unknown', 'value'], [...args.slice(0, 2), '--deadline-utc', '2026-10-27T07:00:00+09:00']]) {
    assert.throws(() => parseContextQaCli(invalid, now));
  }
  assert.throws(() => parseContextQaCli(args, Date.parse(args[3])), /future/);
  await assert.rejects(runCli([], { env: ENV }), /required/);
});

test('CTX04 refuses production-port fallback, missing state opt-in/token or any real provider mode', () => {
  assert.doesNotThrow(() => assertContextQaEnvironment(ENV));
  for (const patch of [{ EGDESK_QA_FIXTURE_PORT: undefined }, { EGDESK_QA_FIXTURE_PORT: '39218' },
    { EGDESK_QA_STATE_FIXTURES: '0' }, { EGDESK_QA_REAL_TURN: '1' }, { EGDESK_QA_REAL_TURN: undefined },
    { EGDESK_QA_FIXTURE_TOKEN: '' }]) assert.throws(() => assertContextQaEnvironment({ ...ENV, ...patch }));
});

test('CTX04 each hung observation is bounded independently and a late result cannot reach acceptance or another action', { timeout: 1000 }, async () => {
  let resolveRead, accepted = 0, actions = 0;
  const pending = (async () => {
    await waitContextBeforeDeadline(() => new Promise(resolve => { resolveRead = resolve; }), () => { accepted++; return true; }, Date.now() + 25);
    actions++;
  })();
  await assert.rejects(pending, /timed out|deadline/);
  resolveRead({ late: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(accepted, 0); assert.equal(actions, 0);
  await assert.rejects(readContextBeforeDeadline(noAction, 1), /deadline/);
  let clock = 10;
  await assert.rejects(waitContextBeforeDeadline(async () => { clock = 30; return true; }, noAction, 30, { now: () => clock }), /deadline/);
});

test('CTX04 deadline closes the owned transport before rejecting native waiters, blocks late continuation and retains unknown remote outcome', { timeout: 1000 }, async () => {
  let release, rejectProfile, actions = 0, closed = 0;
  const raw = { assertRemoteProfile: () => new Promise((resolve, reject) => { release = resolve; rejectProfile = reject; }),
    async click() { await this.assertRemoteProfile(); actions++; }, close() { closed++; rejectProfile(new Error('MCP transport closed')); } };
  const h = guardContextHarness(raw, Date.now() + 25);
  await assert.rejects(h.click('exact-control'), /timed out|deadline|closed/);
  release(); await new Promise(resolve => setImmediate(resolve)); assert.equal(actions, 0);
  await h.close(); assert.equal(closed, 1);
  let finish, rejectNative, localAckTimer, localCallbacks = 0, following = 0, nativeClosed = 0;
  const diagnostics = {}, start = Date.now();
  const inFlight = guardContextHarness({ click: () => { actions++; return new Promise((resolve, reject) => {
    finish = resolve; rejectNative = reject; localAckTimer = setTimeout(() => { localCallbacks++; resolve('late local RPC callback'); }, 133);
  }); }, close() { nativeClosed++; clearTimeout(localAckTimer); rejectNative(new Error('MCP transport closed')); } }, start + 25, { diagnostics });
  const pending = (async () => { await inFlight.click('one-control'); following++; await inFlight.click('forbidden-followup'); })();
  await assert.rejects(pending, /deadline|closed/);
  assert.ok(Date.now() - start < 160, 'the native waiter no longer hangs past the bounded cancellation');
  assert.equal(nativeClosed, 1); assert.equal(diagnostics.records[0].inputOutcome, 'unknown');
  assert.equal(diagnostics.records[0].remoteExecutionCancellationProven, false);
  finish('late RPC result'); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(inFlight.click('forbidden-after-stop'), /stopped/);
  await new Promise(resolve => setTimeout(resolve, 140)); assert.equal(localCallbacks, 0);
  assert.equal(actions, 1); assert.equal(following, 0); await inFlight.close(); assert.equal(nativeClosed, 1);
  await assert.rejects(guardContextHarness({ click: noAction }, Date.now() + 1000).click('no-cancel-path'), /cancellation/);
});

test('CTX04 failure diagnostics retain bounded existing-read scalars and stack, never source/payload/auth/token content', { timeout: 1000 }, async () => {
  const diagnostics = {}, value = { observedAt: Date.now(), count: 1, visible: true, clipped: true, hits: 0,
    rect: { x: 2, y: 3, width: 40, height: 20 }, sourceText: 'PRIVATE_SOURCE', packetText: 'PRIVATE_PAYLOAD',
    sourceMetadata: 'PRIVATE_SOURCE_METADATA', scope: { roomId: 'room-A', owner: 'PRIVATE_OWNER', auth: 'PRIVATE_AUTH' }, token: 'PRIVATE_TOKEN' };
  await assert.rejects(waitContextBeforeDeadline(async () => value, () => false, Date.now() + 25,
    { diagnostics, label: 'initial-ready', selector: '[data-testid="target"]', phase: 'before-input' }), /did not arrive/);
  const failure = diagnostics.records[0];
  assert.equal(failure.status, 'failed'); assert.equal(failure.last.hits, 0); assert.equal(failure.last.clipped, true);
  assert.equal(failure.label, 'initial-ready'); assert.equal(failure.phase, 'before-input'); assert.match(failure.stack, /waitContextBeforeDeadline/);
  for (let i = 0; i < 30; i++) await waitContextBeforeDeadline(async () => value, () => true, Date.now() + 1000, { diagnostics });
  assert.equal(diagnostics.records.length, 24); assert.equal(diagnostics.dropped, 7);
  assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE/);
  assert.doesNotMatch(JSON.stringify(summarizeContextObservation([{ ...value, value: 'PRIVATE_FIELD', text: 'PRIVATE_LABEL' }])), /PRIVATE/);
  await assert.rejects(waitContextBeforeDeadline(async () => ({ ...value, observedAt: Date.now() - 125 }), () => true, Date.now() + 1000,
    { diagnostics, screen: true, label: 'stale-proof' }), /stale/);
  assert.equal(diagnostics.records.at(-1).status, 'failed'); assert.ok(diagnostics.records.at(-1).last.observedAt);
});

test('CTX04 the same nine probes retain bounded top-hit identities and child hits without changing the three-hit failure', async () => {
  const points = [], rect = { left: 53, top: 81.6, right: 85, bottom: 113.6, width: 32, height: 32 };
  const element = (tag, id, cls) => ({ localName: tag, id, getAttribute: name => name === 'class' ? cls : null });
  const bag = element('div', 'egd-preset-bag', 'egd-edge egd-frosted'), svg = element('svg', '', 'egd-ui-icon');
  const node = { ...element('button', '', 'egd-codex-conversation-back'), dataset: {}, parentElement: null,
    getBoundingClientRect: () => rect, contains: child => child === svg, disabled: false };
  const document = { querySelectorAll: selector => { assert.equal(selector, '.egd-codex-conversation-back'); return [node]; },
    elementFromPoint: (x, y) => { points.push({ x, y }); return x < 78 ? bag : y < 100 ? svg : node; } };
  const h = { evaluateChrome: async source => JSON.parse(JSON.stringify(await vm.runInNewContext(`(${source})()`, {
    document, getComputedStyle: () => ({ display: 'inline-flex', visibility: 'visible' }), innerWidth: 1280, innerHeight: 900,
    window: { __egdesk: { state: { codex: { threads: [] } } } }, Date,
  }))) };
  const observation = await observeContextControl(h, '.egd-codex-conversation-back');
  assert.equal(points.length, 9); assert.equal(observation.hits, 3); assert.equal(observation.clipped, false);
  assert.deepEqual(points.map(point => Number(point.x.toFixed(1))), [59.4, 59.4, 59.4, 69, 69, 69, 78.6, 78.6, 78.6]);
  assert.deepEqual(observation.hitSamples.slice(0, 6).map(point => point.hit.id), Array(6).fill('egd-preset-bag'));
  assert.deepEqual(observation.hitSamples.slice(6).map(point => [point.matched, point.hit.tag]), [[true, 'svg'], [true, 'svg'], [true, 'button']]);
  const diagnostics = {};
  await assert.rejects(waitContextBeforeDeadline(async () => observation, value => value.hits === 9, Date.now() + 25,
    { diagnostics, label: 'same-nine-probes' }), /did not arrive/);
  assert.deepEqual(diagnostics.records[0].last.hitSamples, observation.hitSamples);
  const oversized = summarizeContextObservation({ hitSamples: Array(30).fill({ x: 1, y: 2, matched: false,
    hit: { tag: 't'.repeat(100), id: 'i'.repeat(300), class: 'c'.repeat(500), textContent: 'PRIVATE', value: 'PRIVATE' }, text: 'PRIVATE' }) });
  assert.equal(oversized.hitSamples.length, 9);
  assert.deepEqual(Object.values(oversized.hitSamples[0].hit).map(value => value.length), [40, 128, 256]);
  assert.doesNotMatch(JSON.stringify(oversized), /PRIVATE/);
});

test('CTX04 failure screenshot is one bounded observation; failure, hang, expiry and late receipt never replace the original exception', { timeout: 1000 }, async () => {
  const original = new Error('original strict nine-hit readiness failure');
  const result = () => ({ screenshots: [], automatedAssertionsPassed: false });
  const saved = result(); let captures = 0;
  const harness = { click: noAction, press: noAction, evaluateChrome: noAction, screenshot: async (name, options) => {
    captures++; assert.equal(name, 'source-change-failure'); assert.equal(options.allowHeadlessChromeFallback, true);
    assert.ok(options.deadlineMs <= Date.now() + 2000); return '/owned-evidence/source-change-failure.png';
  } };
  await recordContextFailure(harness, original, saved, Date.now() + 60000, { eligible: true });
  await recordContextFailure(harness, new Error('must not replace'), saved, Date.now() + 60000, { eligible: true });
  assert.equal(captures, 1); assert.equal(saved.screenshots.length, 1); assert.equal(saved.failureCapture.status, 'captured');
  assert.equal(saved.error, original.message); assert.equal(saved.automatedAssertionsPassed, false);
  const broken = result();
  await recordContextFailure({ screenshot: async () => { throw new Error('diagnostic capture failure'); } }, original, broken,
    Date.now() + 1000, { eligible: true });
  assert.equal(broken.error, original.message); assert.equal(broken.failureCapture.error, 'diagnostic capture failure');
  let late; const hung = result(), startedAt = Date.now();
  await recordContextFailure({ screenshot: () => new Promise(resolve => { late = resolve; }) }, original, hung, startedAt + 25, { eligible: true });
  assert.ok(Date.now() - startedAt < 200); assert.equal(hung.failureCapture.status, 'failed');
  const frozen = structuredClone(hung); late('/forbidden-late-image.png'); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(hung, frozen); assert.equal(hung.error, original.message); assert.equal(hung.screenshots.length, 0);
  for (const [deadlineMs, eligible] of [[1, true], [Date.now() + 1000, false]]) {
    const skipped = result(); await recordContextFailure({ screenshot: noAction }, original, skipped, deadlineMs, { eligible });
    assert.equal(skipped.failureCapture.status, 'skipped'); assert.equal(skipped.error, original.message);
  }
});

test('Comments failure state reads only the owned QA endpoint once and preserves the original error before IO', async () => {
  const original = new Error('original saved-state assertion'), result = { automatedAssertionsPassed: false };
  let calls = 0, signal;
  const options = { eligible: true, profile: '/owned/profile', env: ENV, now: () => 100,
    fetchImpl: async (url, init) => {
      calls++; signal = init.signal;
      assert.equal(result.error, original.message); assert.match(result.errorStack, /verify-firefox-mcp-context-briefing.test/);
      assert.equal(url, 'http://127.0.0.1:39220/__qa/state'); assert.equal(init.method, 'GET'); assert.equal(init.body, undefined);
      assert.equal(result.failureState.deadlineMs, 850); // Small cap, not the remaining 60 seconds.
      return { ok: true, json: async () => ({ fixture: true, profile: '/owned/profile', auth: 'PRIVATE_AUTH',
        briefingComments: { receipts: [{ method: 'POST', requestId: 'received-post', receivedAt: 50, terminalCause: 'committed-response-lost' }],
          storeInspection: { kind: 'qa-read-only-store', readAt: 60, briefings: [{ count: 1, comments: [{ id: 'saved-id',
            clientRequestId: 'same-uuid', storedHash: 'a'.repeat(64), textHash: 'b'.repeat(64), text: 'PRIVATE_BODY' }] }] } } }) };
    } };
  await recordBriefingFailureState(original, result, 60100, options);
  assert.equal(calls, 1); assert.equal(signal.aborted, false); // Fully consumed HTTP detached its cancellation listener.
  assert.equal(result.failureState.status, 'captured'); assert.equal(result.failureState.attempts, 1);
  assert.equal(result.failureState.summary.receivedPOST, 1); assert.equal(result.failureState.summary.store.totalCount, 1);
  assert.equal(result.automatedAssertionsPassed, false); assert.doesNotMatch(JSON.stringify(result), /PRIVATE/);
  const frozen = structuredClone(result);
  await recordBriefingFailureState(new Error('must not replace'), result, 60100, options);
  assert.equal(calls, 1); assert.deepEqual(result, frozen);
});

test('Comments failure state skips unowned/expired reads and masks failed or foreign fixture responses', async () => {
  const original = new Error('original strict failure');
  for (const [eligible, profile, deadline] of [[false, '/owned', 500], [true, '', 500], [true, '/owned', 100]]) {
    const result = {};
    await recordBriefingFailureState(original, result, deadline, { eligible, profile, env: ENV, now: () => 100, fetchImpl: noAction });
    assert.equal(result.error, original.message); assert.equal(result.failureState.status, 'skipped'); assert.equal(result.failureState.attempts, 0);
  }
  for (const response of [{ ok: false, json: async () => ({ error: 'PRIVATE_HTTP_BODY' }) },
    { ok: true, json: async () => ({ fixture: true, profile: '/foreign', briefingComments: { text: 'PRIVATE_BODY' } }) }]) {
    const result = {}; let calls = 0, signal;
    await recordBriefingFailureState(original, result, Date.now() + 1000, { eligible: true, profile: '/owned', env: ENV,
      fetchImpl: async (_url, options) => { calls++; signal = options.signal; return response; } });
    assert.equal(result.error, original.message); assert.equal(result.failureState.status, 'failed'); assert.equal(calls, 1);
    assert.equal(signal.aborted, false); assert.equal(result.failureState.summary, undefined); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|foreign/);
  }
});

test('Comments failure state aborts hung HTTP/body within remaining budget and discards every late result', { timeout: 10000 }, async () => {
  for (const stage of ['fetch', 'body']) {
    let release, signal, calls = 0, bodyReads = 0;
    const original = new Error('original pending recovery failure'), result = {}, startedAt = Date.now();
    await recordBriefingFailureState(original, result, startedAt + 25, { eligible: true, profile: '/owned', env: ENV,
      fetchImpl: async (_url, options) => {
        calls++; signal = options.signal;
        if (stage === 'fetch') return new Promise(resolve => { release = resolve; }); // Intentionally ignores abort to test late disposal.
        return { ok: true, json: () => { bodyReads++; return new Promise(resolve => { release = resolve; }); } };
      } });
    // The hung promise never settles on its own, so returning at all proves the 25 ms budget aborted it; the bound only guards gross overrun under CPU load.
    assert.ok(Date.now() - startedAt < 2000, 'abort must follow the 25 ms budget'); assert.equal(signal.aborted, true); assert.equal(calls, 1);
    assert.equal(result.error, original.message); assert.equal(result.failureState.status, 'failed'); assert.equal(result.failureState.summary, undefined);
    const frozen = structuredClone(result);
    release(stage === 'fetch' ? { ok: true, json: () => { bodyReads++; return { fixture: true, profile: '/owned' }; } }
      : { fixture: true, profile: '/owned', briefingComments: {} });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(result, frozen); assert.equal(calls, 1); assert.equal(bodyReads, stage === 'body' ? 1 : 0);
  }
});

test('CTX04 HTTP deadline aborts the real request signal, bounds body reads and never retries controls', { timeout: 1000 }, async () => {
  let requests = 0, signal;
  await assert.rejects(contextQaJson('/__qa/context-config', Date.now() + 25, { env: ENV, method: 'POST', body: { fixtureOnly: true },
    fetchImpl: async (url, options) => {
      assert.ok(url.startsWith('http://127.0.0.1:39220/')); requests++; signal = options.signal;
      return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
  }), /deadline/);
  assert.equal(requests, 1); assert.equal(signal.aborted, true);
  await assert.rejects(contextQaJson('/__qa/state', Date.now() + 25, { env: ENV,
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
  }), /timed out|deadline/);
  await assert.rejects(contextQaJson('/__qa/context-config', 1, { env: ENV, method: 'POST', fetchImpl: noAction }), /deadline/);
});

test('CTX04 status and control observers are read-only and input remains full-box/nine-hit with a fresh final scope guard', async () => {
  const sources = [], h = { evaluateChrome: async source => { sources.push(source); return {}; } };
  await observeContextSourceChange(h); await observeContextControl(h, 'exact-target'); await observeBriefingComments(h, ['room-A', 'room-B']);
  for (const source of sources) for (const forbidden of [/dispatchEvent/, /\.click\(/, /\.focus\(/, /\.value\s*=/,
    /scrollTop\s*=/, /scrollIntoView|scrollTo\(|scrollBy\(/, /innerHTML\s*=/, /addEventListener/]) assert.doesNotMatch(source, forbidden);
  let clicks = 0, reads = 0;
  const good = () => ({ observedAt: Date.now(), count: 1, visible: true, inside: true, disabled: false, clipped: false,
    hits: 9, scope: { roomId: 'room-A', owner: 'owner-A' }, identity: { sourceId: 'source-A' }, rect: { top: 1, bottom: 20 } });
  await clickContextControl({ click: async selector => { assert.equal(selector, 'exact-control'); clicks++; } },
    'exact-control', Date.now() + 1000, { read: async () => { reads++; return { ...good(), hitSamples: [{ hit: { tag: reads === 1 ? 'svg' : 'path' } }] }; } });
  assert.equal(clicks, 1); assert.equal(reads, 2);
  for (const patch of [{ hits: 8 }, { clipped: true }, { scope: { roomId: 'foreign-room' } }, { observedAt: Date.now() - 200 }]) {
    let count = 0;
    await assert.rejects(clickContextControl({ click: noAction }, 'exact-control', Date.now() + 1000,
      { read: async () => ({ ...good(), ...(++count === 2 ? patch : {}) }) }), /changed|stale/);
  }
});

test('CTX04 retains same-profile restored-range checkpoint and labels legacy setup instead of claiming native source-change evidence', () => {
  const source = fs.readFileSync(new URL('./verify-firefox-mcp-context-briefing.mjs', import.meta.url), 'utf8');
  assert.match(source, /saved\.profile !== harness\.profile/);
  assert.match(source, /egdesk-context-qa-restart-v1/);
  assert.match(source, /startLine === 201/);
  assert.match(source, /endLine === 240/);
  assert.match(source, /result\.legacySetup/);
  assert.doesNotMatch(source, /127\.0\.0\.1:39218/);
});

function sourceChangeScene() {
  const account = { key: 'codex:fixture:owner-A', variant: 'a', email: 'fixture@example.invalid' }, reads = new Map();
  const identities = ['file', 'browser'].map((kind, i) => {
    const room = { engineId: 'codex', engineProfileId: 'codex-default', clientThreadId: `room-${i}`,
      conversationId: `conversation-${i}`, runId: `run-${i}`, answerId: `conversation-${i}/run-${i}`, title: `Fixture ${kind}` };
    const sourceId = `00000000-0000-4000-8000-00000000000${i}`, text = `old ${kind} source\nline two`;
    const payload = JSON.stringify({ synthetic: true, setupOnly: true, fixtureOnly: true, sourceId, text: `stored ${kind} excerpt` });
    const capture = { id: `selection-${i}`, sourceId, snapshotId: sourceId, hash: fingerprintQaBytes(text).sha256, capturedAt: 1700000000000,
      captureScope: { type: kind === 'file' ? 'file' : 'document-text' }, truncated: false, sourceRef: { kind }, shape: { mime: 'text/plain' } };
    const binding = { conversationId: room.conversationId, runId: room.runId, answerId: room.answerId };
    const packet = { role: 'agent_input', packetId: `packet-${i}`, mime: 'application/json', hash: fingerprintQaBytes(payload).sha256,
      text: payload, mode: 'fixture-only', coverage: { sourceId }, deliveryStatus: 'sent-to-app-server', binding };
    reads.set(sourceId, { capture, source: { role: 'source', mime: 'text/plain', hash: capture.hash, rangeHash: fingerprintQaBytes(text).sha256,
      text, range: { startLine: 1, endLine: 2, totalLines: 2 }, nextLine: null }, delivered: packet, bindings: [{ bindingId: `binding-${i}`, ...binding }] });
    room.sources = [{ selectionId: capture.id, sourceId, snapshotId: sourceId, kind, packetId: packet.packetId,
      captureHash: capture.hash, payloadHash: packet.hash, ...(kind === 'file' ? { path: '/owned-fixture/original.txt' } : { viewId: 'owned-view' }) }];
    return room;
  });
  const seed = { version: 1, setupOnly: true, synthetic: true, ready: true, account, identities,
    initialState: { surfaceMode: 'desk', activeThreadId: identities[0].clientThreadId, entryBypassed: true },
    counts: { seed: { conversations: 2, captures: 2 }, runtimeAtSetup: { captureBatches: 0, fileCaptureOperations: 0, sends: 0, deliveries: 0 } } };
  return { seed, reads };
}

test('CTX04 seed refuses unmarked setup, mixed rooms/engines and nonzero runtime counters without touching UI', () => {
  const { seed } = sourceChangeScene(); assert.equal(assertSourceChangeSeed(seed), seed);
  for (const mutate of [s => { s.setupOnly = false; }, s => { s.synthetic = false; }, s => { s.identities[1].conversationId = s.identities[0].conversationId; },
    s => { s.identities[1].engineId = 'claude'; }, s => { s.identities[0].sources[0].selectionId = s.identities[0].sources[0].sourceId; },
    s => { s.counts.runtimeAtSetup.sends = 1; }]) {
    const bad = structuredClone(seed); mutate(bad); assert.throws(() => assertSourceChangeSeed(bad));
  }
});

async function sourceChangeModel({ transport = 'peer-close', finishDelayMs = 0, lateReopen = false,
  staleProof = false, panelPatch = {}, missingRequest = false, releaseCode = null } = {}) {
  // This is a routing/sequence model, NOT real Gecko, UI callback delivery or
  // product cancellation proof. Receipts deliberately model only server facts.
  const { seed, reads } = sourceChangeScene(), actions = [], checks = [], requests = [], holds = new Map(), statuses = new Map();
  const entries = new Map(), receipts = [], timers = new Set();
  for (const room of seed.identities) statuses.set(room.sources[0].sourceId, { state: 'active', reason: null, changedAt: null });
  let room = seed.identities[0], current = null, activity = false, generation = 0, panelReads = 0;
  const initial = { sourceChangeSeed: seed, context: { captureBatches: 0, fileCaptureOperations: 0, deliveries: [] },
    observed: { sends: [] }, sourceStatus: { receipts } };
  const route = (sourceId, ownerRoom = room) => ({ engineId: ownerRoom.engineId, engineProfileId: ownerRoom.engineProfileId,
    clientThreadId: ownerRoom.clientThreadId, conversationId: ownerRoom.conversationId, sourceId });
  const labels = { loading: '원본 변경 정보 확인 중', active: '추적 범위에서 감지된 변경 없음', failed: '원본 변경 정보를 확인하지 못했습니다',
    missing: '변경 추적 기록 없음 · 최신 여부 미확인', fileChanged: '캡처 후 파일 변경 감지', navigated: '캡처 후 브라우저 페이지 이동 감지', unknown: '캡처 후 원본 변경 감지' };
  const observe = async () => {
    if (!current) return { observedAt: Date.now(), exists: false, roomId: room.clientThreadId };
    const snapshot = reads.get(current.id), s = current.status;
    panelReads++;
    return { observedAt: Date.now() - (staleProof && panelReads === 2 ? 125 : 0), exists: true,
      roomId: room.clientThreadId, scope: { owner: seed.account.key, ...route(current.id) },
      sourceId: current.id, statusSourceId: current.id, statusConversationId: room.conversationId, state: s.state, reason: s.reason,
      statusCount: 1, statusReadable: true, placedBetweenSourceAndDelivery: true, packetExpanded: !!current.expanded,
      statusText: labels[s.state === 'stale' ? s.reason : s.state] + (s.changedAt === null ? '' : ' · 감지 시각 fixture time'),
      changedAt: s.changedAt === null ? null : new Date(s.changedAt).toISOString(),
      sourceLabel: '원문 캡처 · 1–2 / 2행', sourceText: snapshot.source.text, sourceMetadata: `hash ${snapshot.capture.hash}`,
      sourceHashes: [snapshot.capture.hash], rangeHashes: [snapshot.source.rangeHash],
      packetId: snapshot.delivered.packetId, packetText: snapshot.delivered.text, packetMetadata: `hash ${snapshot.delivered.hash}`,
      packetMetadataValues: [{ mode: snapshot.delivered.mode, packetId: snapshot.delivered.packetId, hash: snapshot.delivered.hash }], ...panelPatch };
  };
  const h = { evaluateChrome: async source => { assert.match(source, /document\.querySelector\(selector\)\?\.open/); return true; },
    inspect: async selector => selector.includes('chat-activity-panel') ? activity ? [{}] : [] : [{}] };
  const click = async (_h, selector) => {
    actions.push(selector);
    if (selector.includes('첨부 패널 닫기')) {
      for (const pending of holds.values()) if (pending.generation === current?.generation && transport === 'peer-close') {
        pending.receipt.terminalCause = 'peer-close-before-finish'; pending.receipt.closeAt = Date.now();
        pending.receipt.writableFinishedAtClose = false; holds.delete(pending.sourceId);
      }
      current = null; generation++;
    }
    else if (selector.includes('활동 기록 닫기')) activity = false;
    else if (selector.includes('chat-activity-open')) activity = true;
    else if (selector.includes('chat-input-delivery')) current.expanded = true;
    else if (selector.includes('chat-input-history-open')) {
      const id = /data-snapshot-id="([^"]+)"/.exec(selector)?.[1]; assert.equal(id, room.sources[0].sourceId);
      const pending = holds.get(id); current = { id, status: { ...statuses.get(id) }, generation: ++generation };
      if (pending?.mode === 'error') { current.status = { state: 'failed', reason: null, changedAt: null }; holds.delete(id); }
      else if (pending && pending.generation === undefined) {
        pending.generation = generation; pending.snapshot = { ...current.status }; current.status = { state: 'loading', reason: null, changedAt: null };
        if (!missingRequest) {
          pending.receipt.requestId = `request-${pending.receipt.holdId}`; pending.receipt.receivedAt = Date.now();
          pending.receipt.snapshotHash = fingerprintQaBytes(JSON.stringify(pending.snapshot)).sha256;
        }
      }
    } else assert.fail(`unexpected native action: ${selector}`);
  };
  const request = async (url, options = {}) => {
    requests.push([url, options.method || 'GET']);
    if (url === '/__qa/state') return structuredClone(initial);
    if (url.startsWith('/context/captures/')) {
      const parsed = new URL(url, 'http://fixture.invalid'), id = parsed.pathname.split('/').at(-1);
      const binding = seed.identities.find(r => r.sources[0].sourceId === id);
      for (const key of ['engineId', 'engineProfileId', 'clientThreadId', 'conversationId']) assert.equal(parsed.searchParams.get(key), binding[key]);
      assert.equal(parsed.searchParams.get('packetId'), binding.sources[0].packetId); return structuredClone(reads.get(id));
    }
    assert.equal(options.method, 'POST');
    if (url === '/__qa/context-config') {
      const value = options.body.sourceStatus || options.body.sourceStatusResponse, owner = seed.identities.find(r => r.sources[0].sourceId === value.sourceId);
      for (const [key, expected] of Object.entries(route(value.sourceId, owner))) assert.equal(value[key], expected);
      if (options.body.sourceStatus) statuses.set(value.sourceId, { state: value.state, reason: value.reason, changedAt: value.changedAt });
      else {
        assert.ok(!holds.has(value.sourceId)); const pending = { ...value }; holds.set(value.sourceId, pending);
        if (value.mode === 'hold') {
          assert.ok(value.deadlineAt > Date.now() && value.deadlineAt <= Date.now() + 9000);
          const receipt = { holdId: `hold-${receipts.length}`, armedAt: Date.now(), deadlineAt: value.deadlineAt,
            requestId: null, R: route(value.sourceId, owner), account: seed.account.variant, epoch: 0, heldSourceId: value.sourceId,
            receivedAt: null, snapshotHash: null, releaseAttemptAt: null, releaseAttempts: 0, writeAttempted: false,
            endReturnedAt: null, responseStatus: null, finishAt: null, closeAt: null, writableFinishedAtClose: null, terminalCause: null };
          pending.receipt = receipt; receipts.push(receipt); entries.set(receipt.holdId, pending);
          return { fixtureOnly: true, ok: true, holdId: receipt.holdId, requestId: null };
        }
      }
    } else if (url === '/__qa/context-release') {
      assert.equal(options.includeHttpStatus, true);
      const value = options.body, pending = [...entries.values()].find(entry => entry.receipt.requestId === value.requestId);
      assert.equal(value.phase, 'sources'); assert.ok(value.requestId); assert.ok(pending?.generation);
      for (const key of ['engineId', 'engineProfileId', 'clientThreadId', 'conversationId', 'sourceId']) assert.equal(value[key], pending[key]);
      const receipt = pending.receipt; receipt.releaseAttemptAt = Date.now(); receipt.releaseAttempts++;
      if (releaseCode) return { httpStatus: 409, body: { code: releaseCode, receipt: structuredClone(receipt) } };
      if (receipt.terminalCause === 'peer-close-before-finish') return { httpStatus: 409,
        body: { ok: false, code: 'QA_SOURCE_RESPONSE_ALREADY_CLOSED', receipt: structuredClone(receipt) } };
      receipt.writeAttempted = true; receipt.responseStatus = 200; receipt.endReturnedAt = Date.now();
      const finish = () => {
        receipt.finishAt = Date.now(); receipt.terminalCause = 'finished';
        if (current?.generation === pending.generation) current.status = pending.snapshot;
        else if (lateReopen && !current) current = { id: pending.sourceId, status: pending.snapshot, generation: pending.generation };
        holds.delete(value.sourceId);
      };
      if (finishDelayMs) {
        const timer = setTimeout(() => { timers.delete(timer); finish(); }, finishDelayMs); timers.add(timer);
      } else finish();
      return { httpStatus: 200, body: { fixtureOnly: true, ok: true, receipt: structuredClone(receipt) } };
    } else assert.fail(`unexpected request: ${url}`);
    return { fixtureOnly: true, ok: true };
  };
  const result = {};
  try {
    await verifyContextSourceChange({ harness: h, deadlineMs: Date.now() + (missingRequest ? 150 : 4500), initial, request, result,
      check: (label, passed) => { assert.equal(passed, true); checks.push(label); }, capture: async name => actions.push(`capture:${name}`) },
    { observe, click, select: async (_h, thread) => { room = seed.identities.find(r => r.clientThreadId === thread.id); assert.equal(room.title, thread.title); } });
    return { result, actions, checks, requests, holds, receipts };
  } catch (error) { error.modelEvidence = { result, checks, requests, receipts }; throw error; }
  finally { for (const timer of timers) clearTimeout(timer); }
}

test('CTX04 source-change model uses native-only actions, exact received/closed receipts and no recapture/send', { timeout: 5000 }, async () => {
  const { result, actions, checks, requests, holds } = await sourceChangeModel();
  assert.equal(result.sourceChange.length, 12); assert.equal(checks.length, 18); assert.equal(holds.size, 0);
  assert.deepEqual(result.transportProofs.map(proof => proof.classification),
    ['serverResponseFinished', 'transportAborted', 'transportAborted', 'transportAborted']);
  assert.ok(result.transportProofs.every(proof => proof.uiCallbackDeliveryProven === false));
  assert.deepEqual(result.runtime, { captures: 0, fileReads: 0, sends: 0, deliveries: 0 });
  assert.equal(requests.filter(([url]) => url.startsWith('/context/captures/')).length, 4);
  assert.ok(requests.every(([url, method]) => method === 'GET' || ['/__qa/context-config', '/__qa/context-release'].includes(url)));
  assert.ok(result.closeSafety.observedWindowMs >= 240 && result.roomSafety.observedWindowMs >= 240 && result.replacementSafety.observedWindowMs >= 240);
  assert.ok(actions.every(selector => !/send|attach-confirm|new-thread/.test(selector)));
});

test('CTX04 server-only finish is not relabeled as UI delivery even when the model filters all old responses', { timeout: 5000 }, async () => {
  const { result, checks } = await sourceChangeModel({ transport: 'server-finish' });
  assert.equal(checks.length, 18);
  assert.ok(result.transportProofs.every(proof => proof.classification === 'serverResponseFinished' && proof.uiCallbackDeliveryProven === false));
});

test('CTX04 a 402ms late response cannot pass the old 240ms window before reopening the closed panel', { timeout: 5000 }, async () => {
  await assert.rejects(sourceChangeModel({ transport: 'server-finish', finishDelayMs: 402, lateReopen: true }), error => {
    assert.match(error.message, /reopened/);
    const { result, checks } = error.modelEvidence;
    assert.ok(checks.length < 18); assert.equal(result.closeSafety, undefined);
    const last = result.transportProofs.at(-1);
    assert.equal(last.label, 'panel-close'); assert.equal(last.classification, 'serverResponseFinished');
    assert.ok(last.terminal.finishAt - last.terminal.releaseAttemptAt >= 390);
    return true;
  });
});

test('CTX04 normal prove rejects a 125ms stale sample and wrong initial range/payload metadata against the real store', async () => {
  for (const options of [{ staleProof: true }, { panelPatch: { sourceLabel: '원문 캡처 · 201–240 / 610행' } },
    { panelPatch: { packetMetadataValues: [{ mode: 'fixture-only', packetId: 'packet-0', hash: '0'.repeat(64) }] } }]) {
    await assert.rejects(sourceChangeModel(options), error => {
      assert.match(error.message, /stale|stored range|stored payload hash/);
      assert.equal(error.modelEvidence.checks.length, 1); assert.equal(error.modelEvidence.result.sourceChange.length, 0);
      return true;
    });
  }
});

test('CTX04 a merely armed hold or generic NOT_HELD release cannot become late-response success', { timeout: 2000 }, async () => {
  await assert.rejects(sourceChangeModel({ missingRequest: true }), error => {
    assert.match(error.message, /deadline|timed out/);
    assert.ok(error.modelEvidence.receipts.every(receipt => receipt.requestId === null));
    assert.equal(error.modelEvidence.requests.filter(([url]) => url === '/__qa/context-release').length, 0);
    return true;
  });
  await assert.rejects(sourceChangeModel({ releaseCode: 'QA_SOURCE_RESPONSE_NOT_HELD' }), /no guessed success/);
});

const commentId = n => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function commentsScene() {
  const scene = sourceChangeScene();
  scene.seed.storage = { comments: 'context-json-records', chat: 'sqlite' };
  Object.assign(scene.seed.counts.seed, { briefings: 2, comments: 0 });
  scene.seed.identities.forEach((room, index) => {
    room.briefing = { id: commentId(index + 1), steps: [{ id: `step-${index}`, sourceIds: [room.sources[0].sourceId] }] };
    room.preservation = { draftText: `Existing draft ${index}`, inputSources: [], briefingInputs: [{
      sourceId: room.sources[0].sourceId, snapshotId: room.sources[0].snapshotId, hash: room.sources[0].captureHash,
      sourceRef: { kind: room.sources[0].kind }, capturedAt: 100, packetId: room.sources[0].packetId }], briefingCommentRefs: [] };
  });
  return scene;
}

test('Briefing comments seed requires nonempty immutable briefingInputs, not nonempty inputSources', () => {
  const { seed } = commentsScene(); assert.equal(assertBriefingCommentsSeed(seed), seed);
  assert.ok(seed.identities.every(room => room.preservation.inputSources.length === 0));
  for (const mutate of [s => { s.identities[0].preservation.briefingInputs = []; },
    s => { s.identities[0].preservation.briefingInputs = [{}]; },
    s => { s.identities[1].preservation.draftText = ''; }, s => { s.identities[0].preservation.briefingInputs[0].hash = 'wrong'; },
    s => { s.identities[0].briefing.steps[0].sourceIds = ['foreign']; }, s => { s.storage.comments = 'mock-memory'; }]) {
    const bad = structuredClone(seed); mutate(bad); assert.throws(() => assertBriefingCommentsSeed(bad));
  }
});

async function commentsModel({ transport = 'peer-close', wrongStoredText = false, wrongRecoveryUuid = false,
  autoRepost = false, malformedRepost = false, staleProof = false, lateInjection = false, badRelease = false,
  missingRequest = false, mutateAttachment = false, retryNewUuid = false, retryRewritesEdited = false,
  retryAutoIncludes = false, wrongOriginalDisplay = false, foreignKeyScope = false, receiptMutant = null,
  extraRecoveryGet = null, splitReadability = false, bindingToast = false, extraOpenGet = false } = {}) {
  // Sequence/contract model only: no actual product, Gecko input, storage or
  // callback-delivery proof. Native and fixture implementations are Main QA.
  const { seed, reads } = commentsScene(), actions = [], requests = [], checks = [], receipts = [], comments = [];
  const R = room => Object.fromEntries(['engineId', 'engineProfileId', 'clientThreadId', 'conversationId'].map(key => [key, room[key]]).concat([['briefingId', room.briefing.id]]));
  const drafts = seed.identities.map(room => ({ id: room.clientThreadId,
    scope: { owner: seed.account.key, ...Object.fromEntries(['engineId', 'engineProfileId', 'clientThreadId', 'conversationId'].map(key => [key, room[key]])) },
    draft: room.preservation.draftText, ...structuredClone({ inputSources: room.preservation.inputSources,
      briefingInputs: room.preservation.briefingInputs, briefingCommentRefs: [] }) }));
  let room = seed.identities[0], panel = null, status = 'idle', listState = 'ready', text = '', originalText = '',
    uuid = '', armed = null, pending = null, next = 10;
  const shownIds = new Set();
  const receipt = (method = 'POST', armedOnly = false) => ({ kind: 'production', method, holdId: armedOnly ? commentId(next++) : null,
    requestId: armedOnly ? null : commentId(next++), clientRequestId: null, R: R(room), account: 'a', epoch: 0,
    armedAt: armedOnly ? Date.now() : null, readCompletedAt: null, endReturnedAt: null,
    receivedAt: armedOnly ? null : Date.now(), committedAt: null, commentId: null, seq: null, storedHash: null,
    responseStatus: null, listed: [], releaseAttemptAt: null, releaseAttempts: 0, writeAttempted: false,
    finishAt: null, closeAt: null, writableFinishedAtClose: null, terminalCause: null, responseFault: null });
  const partialLoss = r => {
    const at = Date.now(); r.writeAttempted = true; r.closeAt = at; r.writableFinishedAtClose = false;
    r.responseFault = { mode: 'partial-json', expectedBodyBytes: 100, attemptedBodyBytes: 1,
      headersFlushedAt: at, writeCompletedAt: at, cutAt: at };
  };
  const productGet = lostParent => {
    const r = receipt('GET'); Object.assign(r, { responseStatus: 200, terminalCause: 'finished',
      listed: comments.map(row => ({ id: row.id, clientRequestId: wrongRecoveryUuid && comments.length === 2 ? commentId(999) : row.clientRequestId, seq: row.seq })) });
    r.readCompletedAt = Date.now();
    if (lostParent) {
      partialLoss(r);
      Object.assign(r, { terminalCause: 'recovery-get-response-lost', recoveryOf: {
        holdId: lostParent.holdId, requestId: lostParent.requestId, clientRequestId: lostParent.clientRequestId } });
    }
    else {
      r.writeAttempted = true; r.endReturnedAt = Date.now(); r.finishAt = Date.now();
      for (const row of comments) shownIds.add(row.id); listState = 'ready';
    }
    receiptMutant?.(r, comments.length === 2 ? 'automatic-recovery' : lostParent ? 'lost-recovery' : 'open');
    receipts.push(r);
    if (comments.length === 0 && extraOpenGet) receipts.push({ ...structuredClone(r), requestId: commentId(next++) });
    if (comments.length === 2 && extraRecoveryGet) {
      const extra = structuredClone(r); extra.requestId = commentId(next++);
      if (extraRecoveryGet === 'failed') { extra.responseStatus = 503; extra.readCompletedAt = null; extra.listed = []; }
      if (extraRecoveryGet === 'other-room') extra.R = R(seed.identities[1]);
      if (extraRecoveryGet === 'malformed') extra.receivedAt = undefined;
      receipts.push(extra);
    }
  };
  const stored = () => ({ version: 1, receiptLimit: 64, receipts: structuredClone(receipts), storeInspection: {
    kind: 'qa-read-only-store', readAt: Date.now(), briefings: seed.identities.map(r => ({ briefingId: r.briefing.id,
      conversationId: r.conversationId, account: 'a', count: r === seed.identities[0] ? comments.length : 0, truncated: false,
      comments: r === seed.identities[0] ? comments.map(({ text: _text, ...row }) => row) : [] })) } });
  const state = () => ({ briefingCommentsSeed: structuredClone(seed), briefingComments: stored(),
    context: { captureBatches: 0, fileCaptureOperations: 0, deliveries: [] }, observed: { sends: [] } });
  const included = row => drafts[0].briefingCommentRefs.some(ref => ref.commentId === row.id);
  const include = row => {
    shownIds.add(row.id);
    if (!included(row)) {
      const block = `[Synthetic briefing · 1단계 · 의견 #${row.seq}]\n의견: ${row.text}`;
      drafts[0].draft += `\n\n${block}`;
      drafts[0].briefingCommentRefs.push({ commentId: row.id, commentSeq: row.seq,
        briefingId: seed.identities[0].briefing.id, stepId: row.stepId, draftText: block });
      if (mutateAttachment) drafts[0].briefingInputs[0].hash = 'changed';
    }
    status = 'included';
  };
  const observe = async (_h, _ids, selector = null) => ({ observedAt: Date.now() - (staleProof && comments.length ? 125 : 0),
    activeThreadId: room.clientThreadId, exists: !!panel, cameraSettled: true, preparing: false,
    presentationId: 'synthetic-presentation', sessionThreadId: panel?.clientThreadId, roomGeneration: 1, camera: { zoom: 1, zoomTarget: 1, pan: { x: 0, y: 0 }, panTarget: { x: 0, y: 0 } },
    viewport: { width: 1280, height: 800 }, panel: { id: 'egd-answer-briefing', rect: { left: 100, top: 100, right: 500, bottom: 500 },
      client: { left: 101, top: 101, right: 499, bottom: 499 }, scrollTop: 0, scrollLeft: 0, clientHeight: 398, clientWidth: 398, scrollHeight: 1200, scrollWidth: 398 },
    access: selector && { selector, count: 1, insidePanel: true, full: true, disabled: false, hits: 9, identity: { selector } },
    alerts: bindingToast && panel ? [{ kind: 'board-notice', text: '복원된 대화와 고정 캡처의 원래 연결을 확인하지 못했습니다.' }] : [],
    briefingId: panel?.briefing.id, stepId: panel?.briefing.steps[0].id, title: 'Synthetic briefing',
    status, statusText: status === 'idle' ? '' : 'Status', statusReadable: status !== 'idle' && !(splitReadability && selector?.includes('briefing-comment-row')),
    statusEvidence: { readable: true, rect: { left: 110, top: 110, right: 400, bottom: 140 } }, clientRequestId: uuid, listState,
    inputText: text, originalText: wrongOriginalDisplay ? 'Edited input mislabeled as original' : originalText,
    originalReadable: status === 'unknown', retryEnabled: status === 'unknown', retryClientRequestId: uuid,
    rowCount: panel ? comments.filter(row => shownIds.has(row.id)).length : 0, rows: panel ? comments.filter(row => shownIds.has(row.id)).map(row => ({ id: row.id, seq: row.seq,
      stepId: row.stepId, clientRequestId: row.clientRequestId, text: row.text, target: 'Immutable target', included: included(row),
      readable: !splitReadability || !!selector?.includes('briefing-comment-row'),
      draftStatus: included(row) ? 'Chat 초안에 포함됨 · 아직 전송하지 않음' : '저장됨 · 초안에 포함하지 않음' })) : [], rooms: structuredClone(drafts) });
  const click = async (_h, selector) => {
    actions.push(selector);
    if (selector.includes('briefing-exit')) {
      panel = null;
      if (pending && transport === 'peer-close') Object.assign(pending, { terminalCause: 'peer-close-before-finish',
        closeAt: Date.now(), writableFinishedAtClose: false });
    } else if (selector.includes('briefing-open')) {
      assert.ok(selector.includes(room.answerId)); panel = room; status = 'idle'; productGet();
    } else if (selector.includes('briefing-comment-include')) {
      const id = /data-comment-id="([^"]+)"/.exec(selector)?.[1]; const row = comments.find(row => row.id === id); assert.ok(row); include(row);
    } else if (selector.includes('briefing-comment-retry')) {
      assert.equal(status, 'unknown'); const saved = comments.find(row => row.clientRequestId === uuid); assert.ok(saved);
      const r = receipt(); Object.assign(r, { clientRequestId: retryNewUuid ? commentId(next++) : uuid, committedAt: Date.now(),
        commentId: saved.id, seq: saved.seq, storedHash: saved.storedHash, responseStatus: 201, writeAttempted: true,
        endReturnedAt: Date.now(), finishAt: Date.now(), terminalCause: 'finished' });
      receiptMutant?.(r, 'manual-retry');
      receipts.push(r); shownIds.add(saved.id); status = 'saved';
      if (retryRewritesEdited) text = saved.text;
      if (retryAutoIncludes) include(saved);
    } else if (selector.includes('briefing-comment-attach')) {
      assert.ok(panel && room === seed.identities[0]);
      const existing = comments.find(row => row.clientRequestId === uuid && row.text === text);
      if (existing) { include(existing); return; }
      uuid = commentId(next++); const r = armed?.receipt || receipt();
      if (!armed) receipts.push(r);
      if (missingRequest && armed?.mode === 'hold') { status = 'saving'; return; }
      Object.assign(r, { requestId: commentId(next++), clientRequestId: uuid, receivedAt: Date.now() });
      const row = { id: commentId(next++), clientRequestId: uuid, seq: comments.length + 1, stepId: room.briefing.steps[0].id,
        sourceIds: [...room.briefing.steps[0].sourceIds], text, storedHash: fingerprintQaBytes(`actual record ${uuid}`).sha256,
        textHash: fingerprintQaBytes(wrongStoredText ? 'wrong body, even when UI agrees' : text).sha256 };
      comments.push(row); Object.assign(r, { committedAt: Date.now(), commentId: row.id, seq: row.seq, storedHash: row.storedHash, responseStatus: 201 });
      if (armed?.mode === 'hold') { pending = r; status = 'saving'; }
      else if (armed?.mode === 'committed-response-lost') {
        r.terminalCause = 'committed-response-lost'; partialLoss(r);
        productGet(armed.recoveryGetResponseLostOnce ? r : null);
        status = armed.recoveryGetResponseLostOnce ? 'unknown' : 'saved';
        if (armed.recoveryGetResponseLostOnce) { listState = 'failed'; originalText = text; }
        if (autoRepost || malformedRepost) receipts.push({ ...receipt(), clientRequestId: autoRepost ? uuid : null,
          responseStatus: malformedRepost ? 400 : 201, terminalCause: 'finished' });
      } else { r.writeAttempted = true; r.endReturnedAt = Date.now(); r.finishAt = Date.now(); r.terminalCause = 'finished'; include(row); }
      receiptMutant?.(r, armed?.mode || 'normal-save');
      armed = null;
    } else assert.fail(`Unexpected native input ${selector}`);
  };
  const request = async (url, options = {}) => {
    requests.push([url, options.method || 'GET']);
    if (url === '/__qa/state') return state();
    if (url.startsWith('/context/captures/')) {
      const parsed = new URL(url, 'http://fixture.invalid'), id = parsed.pathname.split('/').at(-1);
      const owner = seed.identities.find(r => r.sources[0].sourceId === id);
      for (const key of ['engineId', 'engineProfileId', 'clientThreadId', 'conversationId']) assert.equal(parsed.searchParams.get(key), owner[key]);
      assert.equal(parsed.searchParams.get('packetId'), owner.sources[0].packetId); return structuredClone(reads.get(id));
    }
    assert.equal(options.method, 'POST');
    for (const [key, value] of Object.entries(R(seed.identities[0]))) assert.equal(options.body[key], value);
    if (url === '/__qa/briefing-comments/config') {
      assert.equal(options.body.bindNextPost, true); assert.equal(options.body.clientRequestId, undefined);
      if (options.body.mode === 'hold') assert.ok(options.body.deadlineAt > Date.now() && options.body.deadlineAt <= Date.now() + 9000);
      else assert.equal(options.body.deadlineAt, undefined);
      const r = receipt('POST', true); receipts.push(r); armed = { receipt: r, mode: options.body.mode,
        recoveryGetResponseLostOnce: options.body.recoveryGetResponseLostOnce };
      receiptMutant?.(r, 'armed');
      return { ok: true, fixtureOnly: true, holdId: r.holdId, requestId: null, clientRequestId: null };
    }
    assert.equal(url, '/__qa/briefing-comments/release'); assert.equal(options.includeHttpStatus, true);
    for (const key of ['holdId', 'requestId', 'clientRequestId']) assert.equal(options.body[key], pending[key]);
    assert.equal(room, seed.identities[1]); assert.equal(panel, null);
    pending.releaseAttemptAt = Date.now(); pending.releaseAttempts++;
    if (badRelease) return { httpStatus: 409, body: { code: 'QA_COMMENT_RESPONSE_NOT_FOUND', receipt: structuredClone(pending) } };
    if (lateInjection) drafts[1].draft += '\nFORBIDDEN LATE COMMENT';
    if (transport === 'peer-close') {
      receiptMutant?.(pending, 'held-cancel');
      return { httpStatus: 409, body: { code: 'QA_COMMENT_ALREADY_CLOSED', receipt: structuredClone(pending) } };
    }
    Object.assign(pending, { terminalCause: 'finished', endReturnedAt: Date.now(), finishAt: Date.now(), writeAttempted: true });
    receiptMutant?.(pending, 'held-release');
    return { httpStatus: 200, body: { ok: true, receipt: structuredClone(pending) } };
  };
  const result = {};
  try {
    const harness = { evaluateChrome: async () => ({ observedAt: Date.now(), scope: { roomId: 'foreign', owner: seed.account.key,
      engineId: 'codex', engineProfileId: 'codex-default' }, count: 1, visible: true, inside: true, disabled: false, clipped: false, hits: 9 }), press: noAction };
    await verifyBriefingComments({ harness, deadlineMs: Date.now() + (missingRequest ? 200 : 3000), initial: state(), request, result,
      check: (label, passed) => { assert.equal(passed, true); checks.push(label); }, capture: async name => actions.push(`capture:${name}`) }, {
      observe, click, reach: async options => { const value = await options.read(); assert.ok(options.accept(value)); return value; },
      select: async (_h, selected) => { actions.push(`select:${selected.id}`); assert.equal(panel, null);
        room = seed.identities.find(r => r.clientThreadId === selected.id); assert.ok(room); },
      replace: async (h, selector, value) => { assert.equal(selector, '[data-testid="briefing-comment"]'); actions.push(`type:${selector}`);
        if (foreignKeyScope) await h.press('Control+a', selector);
        text = value; },
    });
    return { result, checks, receipts, comments, requests, actions, drafts };
  } catch (error) { error.modelEvidence = { result, checks, requests, receipts, comments, actions }; throw error; }
}

test('Briefing comments six-subset model preserves seeded attachments and distinguishes automatic recovery from one explicit retry', { timeout: 3000 }, async () => {
  const { result, checks, requests, receipts, comments, actions, drafts } = await commentsModel();
  assert.equal(checks.length, 11); assert.equal(comments.length, 4); assert.equal(result.comments.length, 4);
  assert.equal(receipts.filter(row => row.method === 'POST' && row.receivedAt !== null).length, 5);
  assert.equal(result.manualRetry.receivedPosts, 2); assert.equal(result.manualRetry.storedComments, 1);
  assert.notEqual(result.manualRetry.originalTextHash, result.manualRetry.editedInputHash);
  assert.equal(result.commentRequestScope.epoch, 0);
  assert.ok(result.getAudits.length <= 64);
  assert.deepEqual(result.getAudits.filter(row => row.count).map(row => [row.label, row.count]),
    [['open-briefing:after', 1], ['open-briefing:after', 1], ['automatic-GET-recovery:after', 1],
      ['open-briefing:after', 1], ['lost-recovery-GET:after', 1]]);
  assert.equal(result.lateTransport.classification, 'transportAborted'); assert.equal(result.lateTransport.uiCallbackDeliveryProven, false);
  assert.ok(result.lateSafety.observedWindowMs >= 240);
  assert.deepEqual(result.runtime, { captures: 0, fileReads: 0, sends: 0, deliveries: 0 });
  assert.ok(requests.every(([url]) => url === '/__qa/state' || url.startsWith('/context/captures/') || url.startsWith('/__qa/briefing-comments/')));
  assert.equal(requests.filter(([url]) => url.startsWith('/context/briefings/')).length, 0);
  assert.equal(actions.filter(action => action.includes('briefing-comment-include')).length, 2);
  assert.equal(actions.filter(action => action.includes('briefing-comment-retry')).length, 1);
  assert.equal(drafts[0].briefingCommentRefs.length, 3); assert.equal(drafts[1].briefingCommentRefs.length, 0);
  assert.ok(drafts.every(draft => draft.inputSources.length === 0 && draft.briefingInputs.length === 1));
});

test('Briefing comments late proof can report server finish only, never UI callback delivery', async () => {
  const { result } = await commentsModel({ transport: 'server-finish' });
  assert.equal(result.lateTransport.classification, 'serverResponseFinished'); assert.equal(result.lateTransport.uiCallbackDeliveryProven, false);
});

test('Briefing comments rejects wrong actual text/attachments, stale UI and automatic or malformed extra POSTs', async () => {
  for (const options of [{ wrongStoredText: true }, { mutateAttachment: true }, { staleProof: true }, { autoRepost: true }, { malformedRepost: true }]) {
    await assert.rejects(commentsModel(options), error => {
      assert.ok(error.modelEvidence.checks.length < 8); return true;
    });
  }
});

test('Briefing comments wrong recovery UUID cannot pass from matching text or a QA-generated GET', { timeout: 3000 }, async () => {
  await assert.rejects(commentsModel({ wrongRecoveryUuid: true }), error => {
    assert.equal(error.modelEvidence.checks.length, 4);
    assert.ok(error.modelEvidence.requests.every(([url]) => !url.startsWith('/context/briefings/'))); return true;
  });
});

test('Briefing comments rejects late draft injection, generic release success and an arm without actual request', { timeout: 2000 }, async () => {
  for (const options of [{ lateInjection: true }, { badRelease: true }, { missingRequest: true }]) {
    await assert.rejects(commentsModel(options), error => {
      assert.ok(error.modelEvidence.checks.length < 8);
      if (options.missingRequest) assert.equal(error.modelEvidence.requests.filter(([url]) => url.endsWith('/release')).length, 0);
      return true;
    });
  }
});

test('Briefing comment manual retry rejects a new UUID, edited-input loss, implicit inclusion and mislabeled original body', { timeout: 15000 }, async () => {
  for (const options of [{ retryNewUuid: true }, { retryRewritesEdited: true }, { retryAutoIncludes: true }, { wrongOriginalDisplay: true }]) {
    await assert.rejects(commentsModel(options), error => {
      assert.ok(error.modelEvidence.checks.length >= 8 && error.modelEvidence.checks.length < 11); return true;
    });
  }
});

test('Briefing comment field replacement checks room before native key dispatch', async () => {
  await assert.rejects(commentsModel({ foreignKeyScope: true }), /native input crossed room/);
});

test('Comments flow accepts separately painted status and row only with unchanged UUID/scope, and never dismisses a binding toast', async () => {
  const { result, checks } = await commentsModel({ splitReadability: true });
  assert.equal(checks.length, 11); assert.equal(result.statusProofs.length, 5);
  assert.ok(result.statusProofs.every(proof => proof.evidence.readable && proof.clientRequestId));
  await assert.rejects(commentsModel({ bindingToast: true }), error => {
    assert.match(error.message, /notice\/alert/); assert.equal(error.modelEvidence.checks.length, 1);
    assert.equal(error.modelEvidence.result.visibleAlerts.length, 1);
    assert.equal(error.modelEvidence.actions.some(action => action.includes('briefing-comment-attach')), false); return true;
  });
});

const wheelExpected = { owner: 'owner-A', route: { engineId: 'codex', engineProfileId: 'codex-default',
  clientThreadId: 'A', conversationId: 'native-A', briefingId: 'briefing-A' }, stepId: 'one' };
function wheelObservation(scrollTop = 0, selector = 'row') {
  return { observedAt: Date.now(), activeThreadId: 'A', sessionThreadId: 'A', briefingId: 'briefing-A', stepId: 'one', presentationId: 'p', roomGeneration: 1,
    exists: true, cameraSettled: true, camera: { zoom: 1, zoomTarget: 1, pan: { x: 0, y: 0 }, panTarget: { x: 0, y: 0 } },
    viewport: { width: 800, height: 600 }, rooms: [{ id: 'A', scope: { owner: 'owner-A', engineId: 'codex', engineProfileId: 'codex-default',
      clientThreadId: 'A', conversationId: 'native-A' }, draft: 'keep', briefingInputs: [{ hash: 'unchanged' }] }],
    inputText: 'saved', originalText: '', status: 'included', clientRequestId: 'request', listState: 'ready', alerts: [], rows: [],
    panel: { id: 'egd-answer-briefing', rect: { left: 99, top: 99, right: 501, bottom: 401 },
      client: { left: 100, top: 100, right: 500, bottom: 400 }, clientHeight: 300, clientWidth: 400,
      scrollHeight: 1500, scrollWidth: 400, scrollTop, scrollLeft: 0 },
    access: { selector, count: 1, identity: { commentId: 'c' }, insidePanel: true, visible: true,
      rect: { left: 120, top: 450 - scrollTop, right: 450, bottom: 550 - scrollTop }, full: scrollTop >= 150 && scrollTop <= 350,
      hits: 9, disabled: false, wheelPoint: { x: 130, y: 200, hits: 9, scrollTarget: 'egd-answer-briefing' } } };
}

test('Native Briefing wheel waits for actual scroll settlement and returns upward to input without extra clicks/keys', { timeout: 5000 }, async () => {
  let top = 0, moving = 0, lastMotionAt = 0; const inputs = [], budget = { total: 0, records: [] }, requests = [];
  const read = async () => {
    if (moving) { top += moving; moving = Math.abs(moving) > 3 ? Math.trunc(moving / 2) : 0; lastMotionAt = Date.now(); }
    return wheelObservation(top);
  };
  const options = { read, selector: 'row', expected: wheelExpected, deadlineMs: Date.now() + 4500, budget,
    accept: v => v.access.full, beforeWheel: async () => { requests.push('before'); return 0; },
    afterWheel: async before => { assert.equal(before, 0); requests.push('after'); return { delta: 0 }; },
    wheel: async input => { inputs.push(input); moving = Math.trunc(input.deltaY / 2); } };
  const reached = await reachBriefingPanelTarget(options);
  assert.ok(reached.access.full); assert.ok(reached.observedAt - lastMotionAt >= 240);
  assert.ok(inputs.length >= 1 && inputs.length <= 6); assert.ok(inputs.every(input => input.deltaX === 0 && input.deltaY > 0));
  assert.equal(budget.records.length, inputs.length); assert.equal(requests.length, inputs.length * 2);
  top = 400; moving = 0; options.accept = v => v.access.full;
  await reachBriefingPanelTarget(options); assert.ok(inputs.at(-1).deltaY < 0); assert.ok(budget.total <= 32);
});

test('Briefing wheel rejects stale samples, changed scope, foreign scroll targets and blocked-inside geometry before input', { timeout: 3000 }, async () => {
  for (const mutate of [v => { v.observedAt -= 125; }, v => { v.access.wheelPoint.scrollTarget = 'textarea'; },
    v => { v.access.wheelPoint.hits = 8; }, v => { v.access.rect.top = 120; v.access.rect.bottom = 220; }]) {
    await assert.rejects(reachBriefingPanelTarget({ selector: 'row', expected: wheelExpected, deadlineMs: Date.now() + 800, budget: { total: 0, records: [] },
      read: async () => { const v = wheelObservation(); mutate(v); return v; }, accept: () => false, wheel: noAction,
      beforeWheel: async () => 0, afterWheel: noAction }));
  }
  let reads = 0;
  await assert.rejects(reachBriefingPanelTarget({ selector: 'row', expected: wheelExpected, deadlineMs: Date.now() + 800, budget: { total: 0, records: [] },
    read: async () => { const v = wheelObservation(); if (++reads > 1) v.rooms[0].draft = 'changed'; return v; },
    accept: () => false, wheel: noAction, beforeWheel: noAction, afterWheel: noAction }), /changed rooms/);
});

test('Briefing wheel applies six-per-access and 32-total caps, rejects HTTP delta and never retries native errors', { timeout: 5000 }, async () => {
  let wheels = 0; const base = { selector: 'row', expected: wheelExpected, read: async () => wheelObservation(), accept: () => false,
    beforeWheel: async () => 0, afterWheel: async () => ({ delta: 0 }), wheel: async () => { wheels++; } };
  await assert.rejects(reachBriefingPanelTarget({ ...base, deadlineMs: Date.now() + 3000, budget: { total: 0, records: [] } }), /limit reached/);
  assert.equal(wheels, 6);
  await assert.rejects(reachBriefingPanelTarget({ ...base, deadlineMs: Date.now() + 800, budget: { total: 32, records: [] } }), /limit reached/);
  assert.equal(wheels, 6);
  await assert.rejects(reachBriefingPanelTarget({ ...base, deadlineMs: Date.now() + 800, budget: { total: 0, records: [] },
    wheel: async () => { wheels++; throw new Error('native outcome unknown'); } }), /native outcome unknown/);
  assert.equal(wheels, 7);
  await assert.rejects(reachBriefingPanelTarget({ ...base, deadlineMs: Date.now() + 1000, budget: { total: 0, records: [] },
    afterWheel: async () => { throw new Error('GET delta 1'); } }), /GET delta 1/);
  assert.equal(wheels, 8);
});

test('Briefing wheel rechecks geometry after request snapshots and does not dispatch on a changed final hit', { timeout: 1000 }, async () => {
  let changed = false;
  await assert.rejects(reachBriefingPanelTarget({ selector: 'row', expected: wheelExpected, deadlineMs: Date.now() + 800, budget: { total: 0, records: [] },
    read: async () => { const v = wheelObservation(); if (changed) v.access.wheelPoint.x++; return v; }, accept: () => false,
    beforeWheel: async () => { changed = true; }, wheel: noAction, afterWheel: noAction }), /changed immediately before wheel/);
});

test('Briefing DOM wheel probe excludes textarea and foreign-card hits and retains only bounded part diagnostics', async () => {
  const selector = '[data-testid="briefing-comment-attach"]';
  const make = (name, box, parent = null) => ({ localName: name, id: '', dataset: {}, parentElement: parent, textContent: '',
    disabled: false, clientLeft: 0, clientTop: 0, clientWidth: box.right - box.left, clientHeight: box.bottom - box.top,
    scrollHeight: box.bottom - box.top, scrollWidth: box.right - box.left, scrollTop: 0, scrollLeft: 0,
    getBoundingClientRect: () => ({ ...box, width: box.right - box.left, height: box.bottom - box.top }), getAttribute: () => null,
    querySelector: () => null, querySelectorAll: () => [],
    contains(node) { for (let p = node; p; p = p.parentElement) if (p === this) return true; return false; },
    closest() { return name === 'textarea' ? this : null; } });
  const root = make('section', { left: 100, top: 100, right: 300, bottom: 220 });
  root.id = 'egd-answer-briefing'; root.dataset = { briefingId: 'briefing', stepId: 'step' }; root.scrollHeight = 500;
  const textarea = make('textarea', { left: 100, top: 100, right: 300, bottom: 140 }, root);
  const other = make('div', { left: 100, top: 140, right: 300, bottom: 180 });
  const button = make('button', { left: 120, top: 260, right: 250, bottom: 290 }, root);
  button.dataset = { testid: 'briefing-comment-attach' };
  let onlyTextarea = false;
  const document = { querySelector: () => root, querySelectorAll: value => value === selector ? [button] : [],
    elementFromPoint: (_x, y) => onlyTextarea || y < 140 ? textarea : y < 180 ? other : root };
  const state = { zoom: 1, zoomTarget: 1, pan: { x: 0, y: 0 }, panTarget: { x: 0, y: 0 }, codex: {
    activeThreadId: 'A', threads: [], briefingSession: { briefing: { title: 'fixture' } } } };
  const h = { evaluateChrome: async source => JSON.parse(JSON.stringify(await vm.runInNewContext(`(${source})()`, {
    document, window: { __egdesk: { state } }, innerWidth: 800, innerHeight: 600, Date,
    getComputedStyle: node => ({ display: 'block', visibility: 'visible', opacity: '1', overflowY: node === root ? 'auto' : 'visible' }),
    ChromeUtils: { importESModule: () => ({}) },
  }))) };
  const value = await observeBriefingComments(h, [], selector);
  assert.deepEqual(value.access.wheelPoint, { x: 116, y: 196, hits: 9, scrollTarget: root.id });
  assert.equal(value.access.full, false); assert.equal(value.access.insidePanel, true);
  onlyTextarea = true; assert.equal((await observeBriefingComments(h, [], selector)).access.wheelPoint, null);
  const summary = summarizeContextObservation({ ...value, statusEvidence: { readable: false, rect: value.access.rect, text: 'PRIVATE' },
    rows: Array.from({ length: 20 }, (_, i) => ({ id: `row-${i}`, text: 'PRIVATE', parts: Object.fromEntries(
      ['body', 'target', 'draft-status'].map(name => [name, { readable: false, rect: value.access.rect, text: 'PRIVATE' }])) })) });
  assert.equal(summary.rowParts.length, 2); assert.equal(summary.statusEvidence.readable, false);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE/);
});

test('Briefing delayed observation cannot turn delivery latency into settlement or dispatch after deadline', { timeout: 1000 }, async () => {
  let clock = 1000, reads = 0;
  await assert.rejects(reachBriefingPanelTarget({ selector: 'row', expected: wheelExpected, deadlineMs: 2000, now: () => clock, budget: { total: 0, records: [] },
    read: async () => { const value = wheelObservation(); value.observedAt = clock; clock += ++reads === 3 ? 210 : 41; return value; },
    accept: () => true, wheel: noAction, beforeWheel: noAction, afterWheel: noAction }), /stale/);
  const start = Date.now(); let actions = 0;
  await assert.rejects(reachBriefingPanelTarget({ selector: 'row', expected: wheelExpected, deadlineMs: start + 25, budget: { total: 0, records: [] },
    read: async () => wheelObservation(), accept: () => false, wheel: async () => { actions++; }, beforeWheel: noAction, afterWheel: noAction }), /deadline/);
  assert.equal(actions, 0);
});

test('Briefing wheel first-read preflight rejects foreign room/owner/engine/profile/native CID/Briefing/step with zero dispatch', async () => {
  for (const mutate of [v => { v.activeThreadId = 'B'; }, v => { v.sessionThreadId = 'B'; },
    v => { v.rooms[0].scope.owner = 'owner-B'; }, v => { v.rooms[0].scope.engineId = 'claude'; },
    v => { v.rooms[0].scope.engineProfileId = 'foreign-profile'; }, v => { v.rooms[0].scope.clientThreadId = 'B'; },
    v => { v.rooms[0].scope.conversationId = 'native-B'; }, v => { v.briefingId = 'briefing-B'; }, v => { v.stepId = 'two'; }]) {
    const budget = { total: 0, records: [] }; let reads = 0;
    await assert.rejects(reachBriefingPanelTarget({ selector: 'row', expected: wheelExpected, deadlineMs: Date.now() + 1000, budget,
      read: async () => { reads++; const v = wheelObservation(); mutate(v); return v; }, accept: () => false,
      wheel: noAction, beforeWheel: noAction, afterWheel: noAction }), /preflight/);
    assert.equal(reads, 1); assert.equal(budget.total, 0); assert.equal(budget.records.length, 0);
  }
});

test('R2 duplicate first-open GET still fails expected one and retains both existing received receipt summaries', async () => {
  await assert.rejects(commentsModel({ extraOpenGet: true }), error => {
    assert.equal(error.message, 'Unexpected total received production GET delta');
    const { result, checks, receipts } = error.modelEvidence;
    assert.equal(checks.length, 1); assert.equal(result.wheel.total, 0);
    const failed = result.diagnostics.records.find(row => row.status === 'failed' && row.label === 'open-briefing-all-production-GETs');
    assert.ok(failed); assert.deepEqual([failed.last.requests.action, failed.last.requests.expected,
      failed.last.requests.before, failed.last.requests.after, failed.last.requests.delta, failed.last.requests.omitted],
    ['open-briefing', 1, 0, 2, 2, 0]);
    assert.deepEqual(failed.last.requests.receipts.map(row => row.requestId), receipts.map(row => row.requestId));
    assert.ok(failed.last.requests.receipts.every(row => row.R.conversationId === 'conversation-0' && row.epoch === 0
      && row.terminalCause === 'finished' && Number.isFinite(row.finishAt)));
    return true;
  });
});

test('Request summary uses the existing read only and cannot replace the original assertion when diagnostics fail', async () => {
  let reads = 0, summaries = 0, accepts = 0; const diagnostics = {}, original = new Error('original action assertion');
  await assert.rejects(waitContextBeforeDeadline(async () => { reads++; return {}; }, () => { accepts++; throw original; }, Date.now() + 1000,
    { diagnostics, requestSummary: () => { summaries++; throw new Error('diagnostic-only error'); } }), error => error === original);
  assert.deepEqual([reads, summaries, accepts], [1, 1, 1]); assert.equal(diagnostics.records.length, 1);
  assert.equal(diagnostics.records[0].last.requestSummaryFailed, true);
  assert.equal(diagnostics.records[0].error, original.message);
});

for (const extraRecoveryGet of ['failed', 'other-room', 'malformed']) {
  test(`Comment action GET audit rejects an additional ${extraRecoveryGet} production GET`, async () => {
    await assert.rejects(commentsModel({ extraRecoveryGet }), error => {
      assert.equal(error.modelEvidence.checks.length, 4);
      assert.equal(error.modelEvidence.receipts.filter(row => row.method === 'GET').length, 4); return true;
    });
  });
}

for (const [name, phase, mutate, transport = 'peer-close'] of [
  ['recovery GET epoch 9', 'automatic-recovery', r => { r.epoch = 9; }],
  ['recovery GET null finishAt', 'automatic-recovery', r => { r.finishAt = null; }],
  ['recovery GET finish before receive', 'automatic-recovery', r => { r.finishAt = r.receivedAt - 1; }],
  ['recovery GET end before read', 'automatic-recovery', r => { r.endReturnedAt = r.readCompletedAt - 1; }],
  ['recovery GET no write', 'automatic-recovery', r => { r.writeAttempted = false; }],
  ['recovery GET close before finish', 'automatic-recovery', r => { r.closeAt = r.finishAt - 1; r.writableFinishedAtClose = true; }],
  ['lost GET crossed epoch', 'lost-recovery', r => { r.epoch = 9; }],
  ['lost GET fake finish', 'lost-recovery', r => { r.finishAt = Date.now(); }],
  ['normal POST missing finish', 'normal-save', r => { r.finishAt = null; }],
  ['manual POST crossed epoch', 'manual-retry', r => { r.epoch = 9; }],
  ['arm crossed captured epoch', 'armed', r => { r.epoch = 9; }],
  ['held cancel missing close', 'held-cancel', r => { r.closeAt = null; }],
  ['held release finish before release', 'held-release', r => { r.finishAt = r.releaseAttemptAt - 1; }, 'server-finish'],
]) {
  test(`Comment receipt regression rejects ${name}`, { timeout: 3000 }, async () => {
    await assert.rejects(commentsModel({ transport, receiptMutant: (r, where) => { if (where === phase) mutate(r); } }), error => {
      assert.ok(error.modelEvidence.checks.length < 11); return true;
    });
  });
}
