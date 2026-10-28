import assert from 'node:assert/strict';
import test from 'node:test';
import { buildChatRequest, chatThreadReadiness, codexAccountChanged, snapshotChatDraft } from '../overlay/resources/EGDeskChatState.sys.mjs';
import { firstCodexAuthOptions, assertFirstCodexDraft, assertFirstCodexReturn,
  assertFirstCodexSend, assertFirstCodexPostCounts, createFirstAuthClickReadiness,
  captureFirstAuthScreenshot } from './verify-firefox-mcp-first-codex-auth-flow.mjs';

const env = { EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_FIRST_CODEX_AUTH_FIXTURE: '1', EGDESK_QA_REAL_TURN: '0',
  EGDESK_QA_FIXTURE_PORT: '48832', EGDESK_QA_FIXTURE_TOKEN: 'only-a-synthetic-test-token',
  EGDESK_MARIONETTE_PORT: '28832', EGDESK_QA_REMOTE_AGENT_PORT: '60832', MOZ_HEADLESS: '1' };
const args = ['--profile', '/tmp/egdesk-chat-test-example', '--evidence-root', '/tmp',
  '--marionette-port', '28832', '--remote-agent-port', '60832', '--deadline-utc', '2026-10-28T22:00:00Z'];
const now = Date.parse('2026-10-28T21:55:00Z');
const draft = 'EGDESK_QA_TEXT_ONLY first-auth-unit';
const room = () => ({ threadCount: 1, title: 'Codex', threadId: 'local-room', wireClientThreadId: 'wire-room',
  engineId: 'codex', profileEnabled: false, agentProfileId: null, conversationId: null, messageCount: 0,
  draft, composerValue: draft, composerThreadId: 'local-room', sendDisabled: true, isLoggedIn: false, loginInProgress: false });
const peer = () => ({ fixture: true, firstCodexAuthFixture: true, profile: '/tmp/egdesk-chat-test-example',
  host: '127.0.0.1', port: 48832, origin: 'http://127.0.0.1:48832',
  firstCodexAuthBoundary: { kind: 'first-codex-auth-fixture-boundary-v1', auth: 'synthetic-fixture', chat: 'synthetic-fixture',
    providerIntegration: 'none-configured-for-first-auth', providerTurnObservation: 'not-instrumented',
    nativeProcessSpawnObservation: 'not-instrumented' },
  runs: [{ runId: 'qa-run-1', clientThreadId: 'wire-room' }],
  observed: { sends: [{ message: draft, clientThreadId: 'wire-room', profileEnabled: false, scenario: 'TEXT_ONLY', runId: 'qa-run-1' }],
    chatSendPostAttempts: { total: 1, signedOut: 0, signedIn: 1 }, authBlockedSends: 0,
    authWrites: [{ route: '/auth/start' }, { route: '/auth/start' }],
    authResults: [{ outcome: 'cancel' }, { outcome: 'success' }] } });

test('first-auth verifier refuses anything but its isolated headless ports, fake auth and future deadline', () => {
  const value = firstCodexAuthOptions(args, env, now);
  assert.equal(value.bridge.port, 48832); assert.equal(value.marionettePort, 28832); assert.equal(value.remoteAgentPort, 60832);
  assert.equal(value.deadlineMs, Date.parse(args[9]));
  for (const patch of [{ EGDESK_QA_FIRST_CODEX_AUTH_FIXTURE: '0' }, { EGDESK_QA_REAL_TURN: '1' },
    { MOZ_HEADLESS: '0' }, { EGDESK_MARIONETTE_PORT: '2829' }, { EGDESK_QA_REMOTE_AGENT_PORT: '6000' },
    { EGDESK_QA_FIXTURE_PORT: '28832' }, { EGDESK_QA_FIXTURE_PORT: '60832' },
    { EGDESK_QA_FIXTURE_PORT: '39218' }, { EGDESK_QA_CLAUDE_FIXTURE: '1' }, { EGDESK_QA_FIXTURE_TOKEN: 'short' }]) {
    assert.throws(() => firstCodexAuthOptions(args, { ...env, ...patch }, now), undefined, JSON.stringify(patch));
  }
  assert.throws(() => firstCodexAuthOptions(args, env, Date.parse('2026-10-28T22:00:00Z')), /deadline/i);
  assert.throws(() => firstCodexAuthOptions(['--profile', 'relative', ...args.slice(2)], env, now), /profile/i);
  assert.throws(() => firstCodexAuthOptions(args.map(value => value === '60832' ? '28832' : value),
    { ...env, EGDESK_QA_REMOTE_AGENT_PORT: '28832' }, now), /distinct/i);
});

test('default Codex draft must be agent-free, unsent, signed out and tied to its exact original room', () => {
  const before = room(); assert.equal(assertFirstCodexDraft(before, draft), true);
  for (const patch of [{ threadCount: 2 }, { title: 'Another room' }, { threadId: '' }, { wireClientThreadId: '' },
    { engineId: 'claude' }, { profileEnabled: true }, { agentProfileId: 'agent' }, { conversationId: 'native' },
    { messageCount: 1 }, { draft: '' }, { composerValue: 'different' }, { composerThreadId: 'different' },
    { sendDisabled: false }, { isLoggedIn: true }, { loginInProgress: true }]) {
    assert.throws(() => assertFirstCodexDraft({ ...before, ...patch }, draft), undefined, JSON.stringify(patch));
  }
});

test('existing Chat state blocks signed-out Codex and builds an agent-free first request after synthetic login', () => {
  const thread = { id: 'local-room', clientBindingId: 'wire-room', profileEnabled: false, agentProfileId: null,
    conversationId: null, messages: [] };
  const before = structuredClone(thread);
  const signedOut = { connected: true, authStatus: { isLoggedIn: false } };
  const signedIn = { connected: true, authStatus: { isLoggedIn: true, authMode: 'chatgpt',
    accountId: 'chatgpt', accountEmail: 'qa-first-codex@egdesk.invalid' } };
  assert.deepEqual(chatThreadReadiness(thread, signedOut), { engineId: 'codex', ready: false, reason: 'Codex 연결 후 전송할 수 있습니다' });
  assert.equal(chatThreadReadiness(thread, signedIn).ready, true);
  assert.equal(codexAccountChanged(null, signedIn.authStatus), false, 'first identity is not an account switch');
  assert.equal(snapshotChatDraft(thread, draft).text, draft);
  const request = buildChatRequest(thread, draft, 'first-request', { engineId: 'codex' });
  assert.equal(request.clientThreadId, 'wire-room'); assert.equal(request.message, draft);
  assert.equal(request.profileEnabled, false); assert.equal(request.engineId, 'codex');
  for (const field of ['agentProfile', 'systemPrompt', 'toolMode']) assert.equal(Object.hasOwn(request, field), false);
  assert.deepEqual(thread, before, 'testing readiness and request shape does not mutate the room');
});

test('both cancellation and successful auth must return to the original room and exact draft without sending', () => {
  const before = room();
  assert.equal(assertFirstCodexReturn(before, room(), false), true);
  const signedIn = { ...room(), isLoggedIn: true, sendDisabled: false };
  assert.equal(assertFirstCodexReturn(before, signedIn, true), true);
  for (const patch of [{ threadId: 'other' }, { wireClientThreadId: 'other' }, { draft: '' }, { composerValue: '' },
    { agentProfileId: 'profile' }, { profileEnabled: true }, { messageCount: 1 }, { conversationId: 'created' },
    { isLoggedIn: false }, { sendDisabled: true }]) {
    assert.throws(() => assertFirstCodexReturn(before, { ...signedIn, ...patch }, true), undefined, JSON.stringify(patch));
  }
});

test('only one explicit agent-free synthetic Codex send with unchanged room binding can pass', () => {
  const options = firstCodexAuthOptions(args, env, now), valid = peer();
  assert.equal(assertFirstCodexSend(valid, room(), options), true);
  for (const mutate of [p => { p.firstCodexAuthBoundary.providerIntegration = 'connected'; },
    p => { p.firstCodexAuthBoundary.nativeProcessSpawnObservation = 'measured-zero'; },
    p => { p.observed.chatSendPostAttempts.total = 2; }, p => { p.observed.chatSendPostAttempts.signedOut = 1; },
    p => { p.observed.chatSendPostAttempts.signedIn = 2; }, p => { delete p.observed.chatSendPostAttempts; },
    p => { p.observed.authBlockedSends = 1; }, p => { p.observed.sends.push({}); },
    p => { p.observed.sends[0].message += '!'; }, p => { p.observed.sends[0].clientThreadId = 'other'; },
    p => { p.observed.sends[0].profileEnabled = true; }, p => { p.observed.sends[0].engineId = 'claude'; },
    p => { p.observed.sends[0].systemPrompt = 'persona'; }, p => { p.observed.authResults.reverse(); },
    p => { p.port = 39218; }, p => { p.firstCodexAuthFixture = false; }]) {
    const bad = structuredClone(valid); mutate(bad);
    assert.throws(() => assertFirstCodexSend(bad, room(), options));
  }
});

test('phase checkpoints reject hidden POSTs even when no send was accepted', () => {
  const value = peer(), zero = { total: 0, signedOut: 0, signedIn: 0 };
  value.observed.sends = [];
  value.observed.chatSendPostAttempts = { ...zero };
  assert.equal(assertFirstCodexPostCounts(value, zero), true);
  for (const counts of [{ total: 1, signedOut: 1, signedIn: 0 }, { total: 1, signedOut: 0, signedIn: 1 },
    { total: 0, signedOut: 0 }, { total: '0', signedOut: 0, signedIn: 0 }, null]) {
    value.observed.chatSendPostAttempts = counts;
    assert.throws(() => assertFirstCodexPostCounts(value, zero));
  }
});

test('auth controls require three stable, in-bounds, unclipped nine-point hit-test samples', () => {
  const sample = () => ({ count: 1, visible: true, disabled: false, inside: true, clipped: false, hitCount: 9,
    rect: { left: 10, top: 20, right: 110, bottom: 60 }, camera: { x: 2, y: 3, zoom: 1, targetX: 2, targetY: 3, targetZoom: 1 } });
  const ready = createFirstAuthClickReadiness(), good = sample();
  assert.equal(ready(good), false); assert.equal(ready(good), false); assert.equal(ready(good), true);
  for (const patch of [{ count: 2 }, { clipped: true }, { inside: false }, { hitCount: 8 },
    { visible: false }, { disabled: true }, { camera: { ...good.camera, targetX: 9 } }]) {
    assert.equal(ready({ ...good, ...patch }), false);
    assert.equal(ready(good), false); assert.equal(ready(good), false); assert.equal(ready(good), true);
  }
});

test('Firefox 158 privileged screenshot fallback is narrow and never converts auth or other errors', async () => {
  let fallbackCalls = 0;
  const fallback = async () => { fallbackCalls++; return '/qa/fallback.png'; };
  for (const message of ['screenshot_page: Error: BiDi error: "unsupported operation"',
    'screenshot_page: Error: BiDi error: "unsupported operation": The command does not support browsing contexts in privileged scope']) {
    assert.equal(await captureFirstAuthScreenshot({ take: async () => { throw new Error(message); }, fallback }), '/qa/fallback.png');
  }
  assert.equal(fallbackCalls, 2);
  assert.equal(await captureFirstAuthScreenshot({ take: async () => '/qa/direct.png', fallback }), '/qa/direct.png');
  for (const message of ['auth failed', 'screenshot timeout', 'screenshot_page: Error: BiDi error: "unsupported operation": other']) {
    await assert.rejects(captureFirstAuthScreenshot({ take: async () => { throw new Error(message); }, fallback }), { message });
  }
  assert.equal(fallbackCalls, 2);
});
