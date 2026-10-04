import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';
import { createQaFixtureTransport } from './egdesk-chat-fixture-transport.mjs';
import { assertNativeTerminalExit } from './egdesk-chat-qa-contract.sys.mjs';
import { assertPublishedBriefing, assertContextCaptureBatch, assertStoredAgentDelivery,
  captureContextReadEvidence, fingerprintQaBytes } from './egdesk-context-qa-contract.mjs';

const TOKEN = 'unit-fixture-token-no-credentials';

function setup(t) {
  const source = fs.mkdtempSync(path.join(canonicalTempRoot(), 'egdesk-loader-fixture-'));
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(source, name), `unit fixture ${name}\n`);
  const { profile } = bootstrapQaProfile({ loaderSource: source });
  t.after(() => {
    for (const [directory, prefix] of [[profile, 'egdesk-chat-test-'], [source, 'egdesk-loader-fixture-']]) {
      assert.equal(path.dirname(directory), canonicalTempRoot());
      assert.ok(path.basename(directory).startsWith(prefix));
      fs.rmSync(directory, { recursive: true, force: false });
    }
  });
  const fetchBefore = globalThis.fetch;
  const eventSourceBefore = globalThis.EventSource;
  const transport = createQaFixtureTransport({ profile, token: TOKEN });
  assert.equal(globalThis.fetch, fetchBefore);
  assert.equal(globalThis.EventSource, eventSourceBefore);
  return transport;
}

async function request(handler, method, url, body = null, token = null) {
  const req = Readable.from(body === null ? [] : [JSON.stringify(body)]);
  Object.assign(req, { method, url, headers: token ? { 'x-egdesk-qa-token': token } : {} });
  let status;
  let headers = {};
  let resolve;
  const completed = new Promise((done) => { resolve = done; });
  const res = {
    writeHead(value, nextHeaders = {}) { status = value; headers = nextHeaders; },
    end(value = '') { resolve({ status, body: value ? (/application\/json/.test(headers['Content-Type'] || '') ? JSON.parse(value) : value) : null }); },
    write() { return true; },
  };
  await handler(req, res);
  return completed;
}

test('fixture rejects unknown bridge/auth/send/approval URLs without forwarding or replacing globals', async (t) => {
  const fetchBefore = globalThis.fetch;
  const eventSourceBefore = globalThis.EventSource;
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => { throw new Error('Real fetch must never be used by fixture transport'); });
  const { handler } = setup(t);
  for (const [method, route] of [
    ['POST', '/auth/unknown-signout'], ['POST', '/auth/start'], ['POST', '/auth/cancel'],
    ['POST', '/account/login/cancel'], ['GET', '/auth/unknown'],
    ['POST', '/chat/send/unknown'], ['POST', '/chat/approval/unknown'],
    ['GET', '/v1/unknown'], ['OPTIONS', '/auth/unknown-signout'],
  ]) {
    assert.equal((await request(handler, method, route, {})).status, 404, `${method} ${route}`);
  }
  assert.equal((await request(handler, 'POST', 'http://127.0.0.1:39218/auth/unknown', {})).status, 404);
  assert.equal((await request(handler, 'POST', 'http://127.0.0.1:39219/auth/signout', {})).status, 400);
  const signedOut = await request(handler, 'POST', '/auth/signout', {});
  assert.equal(signedOut.status, 200);
  assert.equal(signedOut.body.isLoggedIn, false);
  assert.equal((await request(handler, 'GET', '/__qa/state', null, TOKEN)).body.observed.authWrites.length, 1);
  assert.equal(fetchSpy.mock.callCount(), 0);
  fetchSpy.mock.restore();
  assert.equal(globalThis.fetch, fetchBefore);
  assert.equal(globalThis.EventSource, eventSourceBefore);
});

test('fixture refuses ordinary prompts and unauthenticated control routes', async (t) => {
  const { handler } = setup(t);
  assert.equal((await request(handler, 'POST', '/chat/send', { message: 'ordinary real user request', profileEnabled: false })).status, 400);
  assert.equal((await request(handler, 'POST', '/chat/send', { message: 'EGDESK_QA_UNHANDLED test' })).status, 400);
  assert.equal((await request(handler, 'POST', '/__qa/reconnect', {})).status, 403);
  assert.equal((await request(handler, 'GET', '/__qa/state')).status, 403);
  const state = await request(handler, 'GET', '/__qa/state', null, TOKEN);
  assert.equal(state.body.observed.sends.length, 0);
  assert.equal(state.body.runs.length, 0);
});

test('fixture changes synthetic email while keeping generic accountId chatgpt unchanged', async (t) => {
  const { handler } = setup(t);
  const before = (await request(handler, 'GET', '/auth/status')).body;
  assert.equal((await request(handler, 'POST', '/__qa/account-change', { variant: 'b' })).status, 403);
  assert.equal((await request(handler, 'POST', '/__qa/account-change', { variant: 'b' }, TOKEN)).status, 200);
  const after = (await request(handler, 'GET', '/auth/status')).body;
  assert.equal(before.accountId, 'chatgpt');
  assert.equal(after.accountId, before.accountId);
  assert.notEqual(after.accountEmail, before.accountEmail);
  assert.equal(after.isLoggedIn, true);
  assert.equal((await request(handler, 'GET', '/__qa/state', null, TOKEN)).body.observed.authWrites.length, 0);
});

test('fixture-only approval/stop acknowledgements remain usable during auth lookup failure', async (t) => {
  const { handler } = setup(t);
  const sent = await request(handler, 'POST', '/chat/send', { message: 'EGDESK_QA_APPROVAL unit',
    clientThreadId: 'unit-thread', requestId: 'unit-request', profileEnabled: false });
  assert.equal(sent.status, 202);
  const identity = sent.body;
  const snapshot = await request(handler, 'GET', `/chat/state?conversationId=${identity.conversationId}`);
  const approval = snapshot.body.runs[0].pendingApprovals[0];
  assert.deepEqual(approval.choices, ['decline', 'cancel']);
  await request(handler, 'POST', '/__qa/auth-refresh', { fail: true }, TOKEN);
  assert.equal((await request(handler, 'GET', '/auth/status')).status, 503);
  const reply = { approvalId: approval.approvalId, conversationId: identity.conversationId, runId: identity.runId, decision: 'decline' };
  assert.equal((await request(handler, 'POST', '/chat/approval', { ...reply, decision: 'accept' })).status, 400);
  const accepted = await request(handler, 'POST', '/chat/approval', reply);
  assert.equal(accepted.body.status, 'replySent');
  assert.equal((await request(handler, 'POST', '/chat/approval', reply)).status, 409);
  const state = await request(handler, 'GET', `/chat/state?conversationId=${identity.conversationId}`);
  assert.equal(state.body.runs[0].status, 'running');
  assert.equal(state.body.runs[0].pendingApprovals[0].status, 'replySent');
  assert.deepEqual(state.body.runs[0].artifacts, []);
  const stopped = await request(handler, 'POST', '/chat/interrupt', { conversationId: identity.conversationId, runId: identity.runId });
  assert.equal(stopped.body.stopRequested, true);
  assert.equal((await request(handler, 'GET', `/chat/state?conversationId=${identity.conversationId}`)).body.runs[0].status, 'running');
});

test('Terminal fixture is explicit and missing-session output never becomes native exit proof', async (t) => {
  const { handler } = setup(t);
  assert.equal((await request(handler, 'POST', '/terminal/spawn', {})).status, 403);
  await request(handler, 'POST', '/__qa/terminal-mode', { mode: 'unknown' }, TOKEN);
  const spawned = await request(handler, 'POST', '/terminal/spawn', { cols: 80, rows: 24 });
  const sessionId = spawned.body.sessionId;
  const killed = await request(handler, 'POST', '/terminal/kill', { sessionId });
  assert.equal(killed.status, 200);
  assert.equal(killed.body.status, 'STOP_REQUESTED');
  assert.equal(killed.body.exitConfirmed, false);
  const missing = await request(handler, 'POST', '/terminal/read', { sessionId });
  assert.equal(missing.status, 404);
  assert.equal(missing.body.status, 'UNKNOWN');
  assert.equal(missing.body.exited, null);
  assert.equal(missing.body.exitConfirmed, false);
  assert.throws(() => assertNativeTerminalExit(killed.body, sessionId));
  assert.throws(() => assertNativeTerminalExit(missing.body, sessionId));
});

const attachment = (id, sourceRef, kind = 'file', text = '') => ({ id, kind, label: `QA ${id}`, sourceRef,
  capturedAt: 1700000000000, captureScope: { type: kind === 'file' ? 'file' : kind === 'browser' ? 'document-text' : 'board-selection' },
  ...(kind === 'file' ? {} : { content: { mime: 'text/plain', text, truncated: false } }) });

test('short Browser fixture URL serves only the canonical document in this marked profile', async t => {
  const { handler, info } = setup(t);
  const document = path.join(info.profile, 'qa-fixtures', 'context-browser-012345abcd.html');
  const html = '<title>QA source</title><pre>same long content lives here</pre>';
  fs.writeFileSync(document, html, { flag: 'wx', mode: 0o600 });
  const loaded = await request(handler, 'GET', '/__qa/browser-document/012345abcd');
  assert.equal(loaded.status, 200);
  assert.equal(loaded.body, html);
  assert.equal((await request(handler, 'GET', '/__qa/browser-document/not-an-id')).status, 404);
  fs.unlinkSync(document); fs.symlinkSync('/etc/hosts', document);
  assert.equal((await request(handler, 'GET', '/__qa/browser-document/012345abcd')).status, 400);
});

test('final fixture GET paginates immutable source bytes without live rereads or claimed delivery', async t => {
  const { handler, info } = setup(t);
  const file = path.join(info.profile, 'qa-fixtures', 'context-original.txt');
  const lines = Array.from({ length: 610 }, (_, index) => `QA_OLD_${index + 1}`);
  const original = lines.join('\n');
  fs.writeFileSync(file, original, { flag: 'wx', mode: 0o600 });
  const body = { clientThreadId: 'wire-A', attachments: [{ ...attachment('file-A', { path: file }),
    content: { mime: 'text/plain', text: 'must not replace actual file bytes', truncated: false } }] };
  const capture = await request(handler, 'POST', '/context/captures', body);
  assert.equal(capture.status, 200);
  assert.equal(assertContextCaptureBatch(body, capture.body), true);
  const ref = capture.body.captures[0];
  assert.equal(ref.hash, fingerprintQaBytes(original).sha256);
  const first = await request(handler, 'GET', `/context/captures/${ref.sourceId}`);
  assert.equal(first.status, 200);
  assert.equal(captureContextReadEvidence(first.body).source.text, lines.slice(0, 200).join('\n'));
  assert.equal(first.body.source.nextLine, 201);
  assert.equal(first.body.delivered, null);
  assert.deepEqual(first.body.bindings, []);
  fs.writeFileSync(file, 'QA_NEW_LIVE_CONTENT\n');
  const page = await request(handler, 'GET', `/context/captures/${ref.sourceId}?startLine=201&endLine=240`);
  assert.equal(captureContextReadEvidence(page.body).source.text, lines.slice(200, 240).join('\n'));
  assert.equal(page.body.source.hash, ref.hash);
  assert.equal(page.body.source.rangeHash, fingerprintQaBytes(lines.slice(200, 240).join('\n')).sha256);
  assert.equal((await request(handler, 'GET', `/context/captures/${ref.sourceId}?startLine=1&endLine=501`)).status, 400);
  assert.equal((await request(handler, 'GET', `/context/captures/${ref.sourceId}?unknown=true`)).status, 400);
  const final = await request(handler, 'GET', `/context/captures/${ref.sourceId}?startLine=601`);
  assert.equal(final.body.source.nextLine, null);
  const stats = (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
  assert.equal(stats.context.captureBatches, 1);
  assert.equal(stats.context.fileCaptureOperations, 1);
  assert.equal(stats.context.inspectorReads.length, 3);
  assert.equal(stats.context.deliveries.length, 0);
  assert.equal(stats.observed.sends.length, 0);
});

test('fixture capture rejects out-of-root files and remains isolated across synthetic accounts', async t => {
  const fetchSpy = t.mock.method(globalThis, 'fetch', () => { throw new Error('Fixture must not forward HTTP'); });
  const { handler, info } = setup(t);
  assert.equal((await request(handler, 'POST', '/context/captures', { clientThreadId: 'wire-A', attachments: [attachment('outside', { path: '/etc/hosts' })] })).status, 400);
  const alias = path.join(info.profile, 'qa-fixtures', 'outside-link');
  fs.symlinkSync('/etc/hosts', alias);
  assert.equal((await request(handler, 'POST', '/context/captures', { clientThreadId: 'wire-A', attachments: [attachment('alias', { path: alias })] })).status, 400);
  const body = { clientThreadId: 'wire-A', attachments: [attachment('browser', { url: 'https://example.invalid/qa', viewId: 'qa-browser' }, 'browser', 'Visible QA text'),
    attachment('board', { viewId: 'qa-shape' }, 'board', 'Selected QA Board element')] };
  const result = await request(handler, 'POST', '/context/captures', body);
  assert.equal(assertContextCaptureBatch(body, result.body), true);
  await request(handler, 'POST', '/__qa/account-change', { variant: 'b' }, TOKEN);
  assert.equal((await request(handler, 'GET', `/context/captures/${result.body.captures[0].sourceId}`)).status, 404);
  assert.equal(fetchSpy.mock.callCount(), 0);
});

test('fixture context handoff records separate exact packets and same-answer Briefing only after explicit release', async t => {
  const { handler } = setup(t);
  const body = { clientThreadId: 'wire-A', attachments: [attachment('A', { viewId: 'qa-A' }, 'browser', 'First captured source'),
    attachment('B', { viewId: 'qa-B' }, 'board', 'Second captured source')] };
  const captures = (await request(handler, 'POST', '/context/captures', body)).body.captures;
  const sent = await request(handler, 'POST', '/chat/send', { message: 'EGDESK_QA_CONTEXT unit', profileEnabled: false,
    clientThreadId: 'wire-A', requestId: 'request-A', contextSnapshotIds: captures.map(c => c.sourceId),
    contextCapabilities: { publishBriefing: true, read: true, reader: true } });
  assert.equal(sent.status, 202);
  const identity = sent.body;
  const first = await request(handler, 'GET', `/context/captures/${captures[0].sourceId}`);
  assert.equal(first.body.delivered, null);
  assert.equal(first.body.bindings[0].answerId, identity.answerId);
  assert.equal((await request(handler, 'POST', '/__qa/context-release', { runId: identity.runId, phase: 'read' })).status, 403);
  await request(handler, 'POST', '/__qa/context-release', { runId: identity.runId, phase: 'read' }, TOKEN);
  const state = (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
  const observed = state.context.deliveries[0];
  const inspected = captureContextReadEvidence((await request(handler, 'GET', `/context/captures/${captures[0].sourceId}?packetId=${observed.packet.packetId}`)).body);
  assert.equal(assertStoredAgentDelivery(inspected.delivered, { packetId: observed.packet.packetId,
    binding: { conversationId: identity.conversationId, runId: identity.runId, answerId: identity.answerId }, expectedToolText: observed.packet.text }), true);
  assert.notEqual(inspected.source.text, inspected.delivered.text);
  assert.equal(observed.fixtureOnly, true); // Never a real native-tool assertion.
  assert.equal((await request(handler, 'GET', `/context/captures/${captures[0].sourceId}?packetId=missing`)).status, 404);
  await request(handler, 'POST', '/__qa/context-release', { runId: identity.runId, phase: 'briefing' }, TOKEN);
  const run = (await request(handler, 'GET', `/chat/state?conversationId=${identity.conversationId}`)).body.runs[0];
  assert.equal(run.status, 'completed');
  assert.equal(assertPublishedBriefing(run.briefing, { identity, captures }), true);
  assert.equal((await request(handler, 'GET', '/__qa/state', null, TOKEN)).body.observed.sends.length, 1);
});

test('one configured fixture capture failure cannot create a send or silently retry capture', async t => {
  const { handler } = setup(t);
  await request(handler, 'POST', '/__qa/context-config', { failNextCapture: true }, TOKEN);
  const body = { clientThreadId: 'wire-A', attachments: [attachment('A', { viewId: 'qa-A' }, 'browser', 'QA')] };
  assert.equal((await request(handler, 'POST', '/context/captures', body)).status, 503);
  const first = (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
  assert.equal(first.context.captureBatches, 0);
  assert.equal(first.observed.contextCaptureFailures, 1);
  assert.equal(first.observed.sends.length, 0);
  assert.equal((await request(handler, 'POST', '/context/captures', body)).status, 200);
  assert.equal((await request(handler, 'GET', '/__qa/state', null, TOKEN)).body.context.captureBatches, 1);
});

test('delayed capture fixture releases only the selected wire thread and never creates a model send', async t => {
  const { handler } = setup(t);
  await request(handler, 'POST', '/__qa/context-config', { holdNextCapture: true }, TOKEN);
  const body = { clientThreadId: 'wire-A', attachments: [attachment('A', { viewId: 'qa-A' }, 'browser', 'QA held')] };
  const pending = request(handler, 'POST', '/context/captures', body);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await request(handler, 'GET', '/__qa/state', null, TOKEN)).body.pendingContextCaptures, 1);
  assert.equal((await request(handler, 'POST', '/__qa/context-release', { phase: 'capture', clientThreadId: 'wire-B' }, TOKEN)).status, 409);
  assert.equal((await request(handler, 'POST', '/__qa/context-release', { phase: 'capture', clientThreadId: 'wire-A' }, TOKEN)).status, 200);
  assert.equal((await pending).status, 200);
  const state = (await request(handler, 'GET', '/__qa/state', null, TOKEN)).body;
  assert.equal(state.pendingContextCaptures, 0);
  assert.equal(state.observed.sends.length, 0);
});
