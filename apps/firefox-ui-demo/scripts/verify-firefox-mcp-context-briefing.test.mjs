import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import childProcess from 'node:child_process';
import vm from 'node:vm';
import { parseContextQaCli, assertContextQaEnvironment, readContextBeforeDeadline, waitContextBeforeDeadline,
  contextQaJson, guardContextHarness, observeContextSourceChange, observeContextControl, clickContextControl,
  assertSourceChangeSeed, verifyContextSourceChange, summarizeContextObservation, recordContextFailure, runCli } from './verify-firefox-mcp-context-briefing.mjs';
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
  for (const phase of ['core', 'restored-range', 'source-change']) assert.deepEqual(parseContextQaCli([...args, '--phase', phase], now),
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
  await observeContextSourceChange(h); await observeContextControl(h, 'exact-target');
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
