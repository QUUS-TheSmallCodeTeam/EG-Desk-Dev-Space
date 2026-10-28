#!/usr/bin/env node
// Headless-only, synthetic first-Codex auth regression. Importing starts no
// service or browser. The caller owns the already-running isolated fixture and
// Firefox, and the product receives only native test inputs and fixture events.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qaBridgeConfig, validateQaFixtureIsolation } from './egdesk-qa-fixture-isolation.mjs';
import { assertQaFixtureManifest, canonicalTempRoot } from './egdesk-chat-qa-profile.mjs';

export function firstCodexAuthOptions(argv, env = process.env, now = Date.now()) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(['--profile', '--evidence-root', '--deadline-utc', '--marionette-port', '--remote-agent-port'].includes(argv[i]) && argv[i + 1]
      && !argv[i + 1].startsWith('--') && !values.has(argv[i]), 'Expected unique profile, evidence-root and deadline arguments');
    values.set(argv[i], argv[i + 1]);
  }
  const profile = values.get('--profile'), evidenceRoot = values.get('--evidence-root'), utc = values.get('--deadline-utc');
  const marionetteText = values.get('--marionette-port'), remoteText = values.get('--remote-agent-port');
  const validPort = value => typeof value === 'string' && /^[1-9][0-9]{0,4}$/.test(value)
    && Number(value) >= 1024 && Number(value) <= 65535;
  assert.ok(validPort(marionetteText) && validPort(remoteText), 'Explicit valid QA automation ports are required');
  const marionettePort = Number(marionetteText), remoteAgentPort = Number(remoteText);
  assert.ok(marionettePort !== remoteAgentPort && ![39218, 39219].includes(marionettePort)
    && ![39218, 39219].includes(remoteAgentPort), 'Automation ports must be distinct from each other and the personal bridge');
  assert.ok(profile && path.isAbsolute(profile) && path.resolve(profile) === profile, 'An explicit canonical QA profile path is required');
  assert.ok(evidenceRoot && path.isAbsolute(evidenceRoot) && path.resolve(evidenceRoot) === evidenceRoot, 'An explicit canonical evidence root is required');
  assert.equal(env.EGDESK_QA_FIXTURE_TRANSPORT, '1');
  assert.equal(env.EGDESK_QA_FIRST_CODEX_AUTH_FIXTURE, '1');
  assert.equal(env.EGDESK_QA_REAL_TURN, '0');
  assert.equal(env.MOZ_HEADLESS, '1', 'Headless Firefox is required');
  assert.equal(env.EGDESK_MARIONETTE_PORT, marionetteText, 'Marionette port must match the explicitly selected QA target');
  assert.equal(env.EGDESK_QA_REMOTE_AGENT_PORT, remoteText, 'Remote-agent port must match the explicitly selected QA target');
  assert.ok(typeof env.EGDESK_QA_FIXTURE_TOKEN === 'string' && env.EGDESK_QA_FIXTURE_TOKEN.length >= 16, 'Fixture token required');
  for (const [key, value] of Object.entries(env)) {
    if (key !== 'EGDESK_QA_FIRST_CODEX_AUTH_FIXTURE' && (/^EGDESK_QA_.*_FIXTURE$/.test(key)
      || ['EGDESK_QA_STATE_FIXTURES', 'EGDESK_QA_CONTEXT_SOURCE_CHANGE_SEED', 'EGDESK_QA_BRIEFING_COMMENTS_SEED',
        'EGDESK_QA_BROWSER_NEGATIVE', 'EGDESK_QA_BROWSER_RELAY'].includes(key))) {
      assert.ok(value == null || value === '' || value === '0', `First-auth fixture excludes ${key}`);
    }
  }
  const bridge = qaBridgeConfig(env);
  assert.ok(![marionettePort, remoteAgentPort, 39218, 39219].includes(bridge.port), 'Fixture must use its own port');
  assert.match(utc || '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/, 'A UTC deadline is required');
  const deadlineMs = Date.parse(utc);
  assert.ok(Number.isFinite(deadlineMs) && deadlineMs - now >= 240_000 && deadlineMs - now <= 15 * 60_000,
    'QA deadline must allow at least four minutes and be within 15 minutes');
  return { profile, evidenceRoot, bridge, marionettePort, remoteAgentPort, deadlineMs };
}

export function assertFirstCodexDraft(value, draft) {
  assert.equal(value?.threadCount, 1); assert.equal(value.title, 'Codex');
  assert.ok(typeof value.threadId === 'string' && value.threadId);
  assert.ok(typeof value.wireClientThreadId === 'string' && value.wireClientThreadId);
  assert.equal(value.engineId, 'codex'); assert.equal(value.profileEnabled, false); assert.equal(value.agentProfileId, null);
  assert.equal(value.conversationId, null); assert.equal(value.messageCount, 0);
  assert.equal(value.draft, draft); assert.equal(value.composerValue, draft); assert.equal(value.composerThreadId, value.threadId);
  assert.equal(value.sendDisabled, true); assert.equal(value.isLoggedIn, false); assert.equal(value.loginInProgress, false);
  return true;
}

export function assertFirstCodexReturn(before, after, signedIn) {
  assert.equal(after?.threadCount, before.threadCount); assert.equal(after.title, before.title);
  for (const field of ['threadId', 'wireClientThreadId', 'engineId', 'profileEnabled', 'agentProfileId',
    'conversationId', 'messageCount', 'draft', 'composerValue', 'composerThreadId']) assert.equal(after[field], before[field], field);
  assert.equal(after.isLoggedIn, signedIn); assert.equal(after.loginInProgress, false);
  assert.equal(after.sendDisabled, !signedIn);
  return true;
}

function assertFirstCodexPeer(peer, options) {
  assert.equal(peer?.fixture, true); assert.equal(peer.firstCodexAuthFixture, true); assert.equal(peer.profile, options.profile);
  for (const key of ['host', 'port', 'origin']) assert.equal(peer[key], options.bridge[key]);
  // Structural fixture metadata is not a process/network measurement.
  assert.deepEqual(peer.firstCodexAuthBoundary, { kind: 'first-codex-auth-fixture-boundary-v1',
    auth: 'synthetic-fixture', chat: 'synthetic-fixture', providerIntegration: 'none-configured-for-first-auth',
    providerTurnObservation: 'not-instrumented', nativeProcessSpawnObservation: 'not-instrumented' });
  assert.equal(peer.observed?.authBlockedSends, 0, 'The UI must not POST while signed out');
}

export function assertFirstCodexPostCounts(peer, expected) {
  assert.deepEqual(peer.observed?.chatSendPostAttempts, expected, 'Every /chat/send POST must match the phase checkpoint');
  return true;
}

export function assertFirstCodexSend(peer, before, options) {
  assertFirstCodexPeer(peer, options);
  assertFirstCodexPostCounts(peer, { total: 1, signedOut: 0, signedIn: 1 });
  assert.deepEqual(peer.observed.authWrites.map(row => row.route), ['/auth/start', '/auth/start']);
  assert.deepEqual(peer.observed.authResults.map(row => row.outcome), ['cancel', 'success']);
  assert.equal(peer.observed.sends.length, 1);
  const send = peer.observed.sends[0];
  assert.equal(send.message, before.draft); assert.equal(send.clientThreadId, before.wireClientThreadId);
  assert.equal(send.profileEnabled, false); assert.ok(!send.engineId || send.engineId === 'codex');
  assert.equal(send.scenario, 'TEXT_ONLY');
  for (const field of ['agentProfile', 'systemPrompt', 'toolMode']) assert.equal(Object.hasOwn(send, field), false, field);
  assert.equal(peer.runs.length, 1); assert.equal(peer.runs[0].runId, send.runId);
  assert.equal(peer.runs[0].clientThreadId, before.wireClientThreadId);
  return true;
}

// Firefox 158 adds a detail to the otherwise identical privileged-context
// screenshot refusal. Only these two exact errors select the existing guarded
// headless drawSnapshot fallback; unrelated errors remain observable.
export async function captureFirstAuthScreenshot({ take, fallback }) {
  try { return await take(); }
  catch (error) {
    const supported = new Set([
      'screenshot_page: Error: BiDi error: "unsupported operation"',
      'screenshot_page: Error: BiDi error: "unsupported operation": The command does not support browsing contexts in privileged scope',
    ]);
    if (!(error instanceof Error) || !supported.has(error.message)) throw error;
    return fallback();
  }
}

// Three stable, fully hit-tested samples; callers take a fresh fourth sample
// before one native click. No DOM/state writes are used to move a target.
export function createFirstAuthClickReadiness() {
  let previous = null, stable = 0;
  return value => {
    const r = value?.rect, c = value?.camera;
    const ready = value?.count === 1 && value.visible === true && value.disabled === false && value.inside === true
      && value.clipped === false && value.hitCount === 9 && r && c
      && [r.left, r.top, r.right, r.bottom, c.x, c.y, c.zoom, c.targetX, c.targetY, c.targetZoom].every(Number.isFinite)
      && r.right > r.left && r.bottom > r.top && Math.abs(c.x - c.targetX) < 0.25
      && Math.abs(c.y - c.targetY) < 0.25 && Math.abs(c.zoom - c.targetZoom) < 0.0001;
    if (!ready) { previous = null; stable = 0; return false; }
    const geometry = [r.left, r.top, r.right, r.bottom, c.x, c.y, c.zoom];
    stable = previous && geometry.every((number, i) => Math.abs(number - previous[i]) <= 0.25) ? stable + 1 : 1;
    previous = geometry;
    return stable >= 3;
  };
}

async function observeTarget(harness, selector, chrome) {
  return chrome(harness, selector => {
    const nodes = [...document.querySelectorAll(selector)], node = nodes.length === 1 ? nodes[0] : null;
    const r = node?.getBoundingClientRect(), state = window.__egdesk?.state;
    let visible = !!node?.isConnected, clipped = false, hitCount = 0;
    for (let current = node; current && r; current = current.parentElement) {
      const style = getComputedStyle(current), box = current.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) visible = false;
      if (current !== node && ((/(auto|scroll|hidden|clip)/.test(style.overflowX) && (r.left < box.left || r.right > box.right))
        || (/(auto|scroll|hidden|clip)/.test(style.overflowY) && (r.top < box.top || r.bottom > box.bottom)))) clipped = true;
    }
    if (r) for (const y of [0.2, 0.5, 0.8]) for (const x of [0.2, 0.5, 0.8]) {
      const hit = document.elementFromPoint(r.left + r.width * x, r.top + r.height * y);
      if (hit && (hit === node || node.contains(hit))) hitCount++;
    }
    return { count: nodes.length, visible, disabled: !!node?.disabled, clipped, hitCount,
      inside: !!r && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      rect: r && { left: r.left, top: r.top, right: r.right, bottom: r.bottom },
      camera: { x: state?.pan?.x, y: state?.pan?.y, zoom: state?.zoom,
        targetX: state?.panTarget?.x, targetY: state?.panTarget?.y, targetZoom: state?.zoomTarget } };
  }, selector);
}

async function observeRoom(harness, chrome) {
  return chrome(harness, () => {
    const codex = window.__egdesk.state.codex;
    const thread = codex.threads.find(row => row.id === codex.activeThreadId);
    const module = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
    const input = document.querySelector('[data-testid="chat-composer"]');
    const send = document.querySelector('[data-testid="chat-send"]');
    return { threadCount: codex.threads.length, title: thread?.title || null, threadId: thread?.id || null,
      wireClientThreadId: thread ? module.clientThreadBinding(thread) : null,
      engineId: thread ? module.chatThreadEngineId(thread, codex) : null,
      profileEnabled: thread?.profileEnabled === true, agentProfileId: thread?.agentProfileId || null,
      conversationId: thread?.conversationId || null, messageCount: thread?.messages?.length ?? null,
      userMessages: (thread?.messages || []).filter(row => row.role === 'user').map(row => row.content || row.text || ''),
      draft: thread ? codex.threadDrafts[thread.id] || '' : null,
      composerValue: input?.value ?? null, composerThreadId: input?.dataset.threadId || null,
      sendDisabled: send ? !!send.disabled : null, isLoggedIn: codex.authStatus?.isLoggedIn === true,
      loginInProgress: codex.authStatus?.loginInProgress === true };
  });
}

export async function runFirstCodexAuthFlow(options) {
  assert.equal(fs.realpathSync.native(options.evidenceRoot), options.evidenceRoot, 'Evidence root must be canonical');
  assert.equal(canonicalTempRoot(), options.evidenceRoot, 'TMPDIR must point to the owned evidence root');
  assert.equal(path.dirname(options.profile), options.evidenceRoot, 'QA profile must be a direct child of the evidence root');
  assertQaFixtureManifest(options.profile);
  const isolation = validateQaFixtureIsolation(options.profile);
  const { runUiFlow, loopbackJson, openChat, selectQaThread, visible, waitUntil, chrome } = await import('./egdesk-qa-ui-flow.mjs');
  const { captureQaScreenshot } = await import('./firefox-mcp-chat-harness.mjs');
  const { prepareRunOutputDesk } = await import('./verify-firefox-mcp-chat-run-outputs-flow.mjs');
  const { observeFirstUse } = await import('./verify-firefox-mcp-headless-ui-regression.mjs');
  // runUiFlow can spend up to 90 seconds capturing a failure before closing
  // its own MCP process. Preserve that time plus a cleanup margin on every
  // new action, rather than treating the deadline as a screenshot trigger.
  const deadline = (reserveMs = 0) => assert.ok(Date.now() + 120000 + reserveMs < options.deadlineMs,
    'First-auth QA deadline reached or insufficient safe time remains');
  const readFixture = async () => {
    deadline();
    const value = await loopbackJson('/__qa/state', { token: process.env.EGDESK_QA_FIXTURE_TOKEN });
    assertFirstCodexPeer(value, options); return value;
  };
  const readAuth = async () => { deadline(); return loopbackJson('/auth/status'); };
  const complete = async (loginId, outcome) => {
    deadline(10000); return loopbackJson('/__qa/auth-result', { method: 'POST', token: process.env.EGDESK_QA_FIXTURE_TOKEN,
      body: { loginId, outcome } });
  };
  await runUiFlow('first-codex-auth', async ({ harness, result, check }) => {
    // The shared result's default says "not-run"; this verifier does not
    // instrument provider calls or process creation across the QA process tree.
    result.providerTurn = 'not-measured';
    result.osIsolationEvidence = { verifiedByVerifier: false,
      note: 'OS sandbox enforcement and Firefox child-sandbox settings require separate launcher evidence.' };
    assert.equal(harness.profile, options.profile, 'Harness must attach to the exact fixture profile');
    result.isolation = isolation;
    const root = await chrome(harness, () => {
      const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
      return { headless: Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo).isHeadless,
        uri: document.documentURI, marionette: services.prefs.getIntPref('marionette.port'),
        remote: services.prefs.getIntPref('devtools.debugger.remote-port') };
    });
    assert.deepEqual(root, { headless: true, uri: 'chrome://browser/content/browser.xhtml',
      marionette: options.marionettePort, remote: options.remoteAgentPort });
    const screenshotOptional = async name => {
      deadline(95000);
      try {
        const screenshotDeadline = Math.min(options.deadlineMs - 120000, Date.now() + 90000);
        const screenshot = await captureFirstAuthScreenshot({
          take: () => harness.screenshot(name, { allowHeadlessChromeFallback: true, deadlineMs: screenshotDeadline }),
          // Normalize the already-observed exact 158 refusal to the older
          // guarded fallback sentinel; no authentication result is caught.
          fallback: async () => (await captureQaScreenshot({ name, evidenceDir: harness.evidenceDir,
            assertRemoteProfile: () => harness.assertRemoteProfile(),
            screenshotPage: async () => { throw new Error('screenshot_page: Error: BiDi error: "unsupported operation"'); },
            evaluateChrome: source => harness.evaluateChrome(source),
            allowHeadlessChromeFallback: true, deadlineMs: screenshotDeadline })).path,
        });
        result.screenshots.push(screenshot);
      } catch (error) {
        (result.screenshotErrors ||= []).push({ name, error: error.message });
      }
    };
    const click = async (selector, beforeClick = async () => {}) => {
      const ready = createFirstAuthClickReadiness();
      await waitUntil(async () => { deadline(); return observeTarget(harness, selector, chrome); }, ready,
        { timeoutMs: 15000, intervalMs: 100 });
      deadline(30000); const fresh = await observeTarget(harness, selector, chrome);
      assert.ok(ready(fresh), `Control changed before native click: ${selector}`);
      await beforeClick();
      await harness.click(selector);
    };
    const recordZeroPosts = (phase, value) => {
      assertFirstCodexPostCounts(value, { total: 0, signedOut: 0, signedIn: 0 });
      (result.sendPostAttempts ||= {})[phase] = structuredClone(value.observed.chatSendPostAttempts);
    };
    const peer = await waitUntil(readFixture, value => value.clients > 0, { timeoutMs: 15000 });
    result.fixtureBoundary = peer.firstCodexAuthBoundary;
    recordZeroPosts('initial', peer);
    assert.equal(peer.observed.sends.length, 0); assert.equal(peer.runs.length, 0);
    assert.deepEqual(peer.observed.authWrites, []); assert.deepEqual(peer.observed.authResults, []);
    const initialAuth = await readAuth();
    assert.equal(initialAuth.isLoggedIn, false); assert.equal(initialAuth.accountId, null); assert.equal(initialAuth.accountEmail, null);
    result.initialDesk = await prepareRunOutputDesk(harness, { deadlineMs: options.deadlineMs, readFirstUse: observeFirstUse, waitUntil });
    deadline(30000); await openChat(harness);
    const threads = await chrome(harness, () => window.__egdesk.state.codex.threads.map(row => ({ id: row.id, title: row.title })));
    assert.equal(threads.length, 1); assert.equal(threads[0].title, 'Codex');
    if (!(await harness.inspect('[data-testid="chat-composer"]')).some(node => node.visible)) await selectQaThread(harness, threads[0]);
    await visible(harness, '[data-testid="chat-composer"]');
    const draft = `EGDESK_QA_TEXT_ONLY first-codex-auth-${Date.now().toString(36)}`;
    await click('[data-testid="chat-composer"]');
    deadline(30000); await harness.typeText(draft, { selector: '[data-testid="chat-composer"]' });
    const before = await waitUntil(() => { deadline(); return observeRoom(harness, chrome); }, value => value.draft === draft && value.composerValue === draft,
      { timeoutMs: 10000 });
    assertFirstCodexDraft(before, draft); result.before = before;
    deadline(30000); await harness.press(process.platform === 'darwin' ? 'meta+Enter' : 'Control+Enter', '[data-testid="chat-composer"]');
    await new Promise(resolve => setTimeout(resolve, 500));
    const blocked = await readFixture(); recordZeroPosts('afterSignedOutShortcut', blocked);
    assert.equal(blocked.observed.sends.length, 0);
    assertFirstCodexDraft(await observeRoom(harness, chrome), draft);
    check('signed-out shortcut preserves the default draft and sends nothing', true);
    await screenshotOptional('first-codex-before-auth');

    const visitSettings = async outcome => {
      await click('#egd-dock .egd-dock-btn[data-id="settings"]');
      await click('[data-testid="settings-account"][data-state="signed-out"] button');
      const pending = await waitUntil(readAuth, value => value.loginInProgress && /^qa-auth-/.test(value.authSessionId || ''),
        { timeoutMs: 10000 });
      await waitUntil(() => { deadline(); return observeRoom(harness, chrome); }, value => value.loginInProgress,
        { timeoutMs: 10000 });
      const pendingFixture = await readFixture(); recordZeroPosts(`${outcome}LoginPending`, pendingFixture);
      assert.equal(pendingFixture.observed.sends.length, 0);
      await complete(pending.authSessionId, outcome);
      await waitUntil(readAuth, value => !value.loginInProgress && value.isLoggedIn === (outcome === 'success'), { timeoutMs: 10000 });
      await click('#egd-dock .egd-dock-btn[data-id="chat"]');
      return waitUntil(() => { deadline(); return observeRoom(harness, chrome); }, value => value.threadId === before.threadId
        && value.composerValue === draft && value.isLoggedIn === (outcome === 'success')
        && value.sendDisabled === (outcome !== 'success'), { timeoutMs: 15000 });
    };
    const cancelled = await visitSettings('cancel');
    assertFirstCodexReturn(before, cancelled, false); result.afterCancellation = cancelled;
    const afterCancellation = await readFixture(); recordZeroPosts('afterCancellation', afterCancellation);
    assert.equal(afterCancellation.observed.sends.length, 0);
    check('synthetic cancellation returns to the same unsent room and draft', true);
    const signedIn = await visitSettings('success');
    assertFirstCodexReturn(before, signedIn, true); result.afterSuccess = signedIn;
    assert.equal((await readAuth()).accountEmail, 'qa-first-codex@egdesk.invalid');
    const afterSuccess = await readFixture(); recordZeroPosts('afterSuccess', afterSuccess);
    assert.equal(afterSuccess.observed.sends.length, 0);
    check('synthetic login returns to the same draft without automatic send', true);
    await screenshotOptional('first-codex-after-auth');
    await click('[data-testid="chat-send"]', async () => recordZeroPosts('beforeExplicitSend', await readFixture()));
    await waitUntil(readFixture, value => value.observed.sends.length === 1 && value.runs.length === 1
      && value.runs[0].status === 'completed',
      { timeoutMs: 15000 });
    await new Promise(resolve => setTimeout(resolve, 500));
    const final = await readFixture();
    assertFirstCodexSend(final, before, options);
    result.sendPostAttempts.afterExplicitSend = structuredClone(final.observed.chatSendPostAttempts);
    const sentRoom = await waitUntil(() => { deadline(); return observeRoom(harness, chrome); }, value => value.threadId === before.threadId
      && value.userMessages.includes(draft) && !!value.conversationId, { timeoutMs: 15000 });
    assert.equal(sentRoom.wireClientThreadId, before.wireClientThreadId);
    result.sentRoom = sentRoom; result.finalFixture = final;
    check('one explicit ordinary Codex send stays in the original room with a synthetic fixture response', true);
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await runFirstCodexAuthFlow(firstCodexAuthOptions(process.argv.slice(2))); }
  catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
