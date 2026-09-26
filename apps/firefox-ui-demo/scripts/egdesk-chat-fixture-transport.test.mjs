import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';
import { createQaFixtureTransport } from './egdesk-chat-fixture-transport.mjs';
import { assertNativeTerminalExit } from './egdesk-chat-qa-contract.sys.mjs';

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
  let resolve;
  const completed = new Promise((done) => { resolve = done; });
  const res = {
    writeHead(value) { status = value; },
    end(value = '') { resolve({ status, body: value ? JSON.parse(value) : null }); },
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
