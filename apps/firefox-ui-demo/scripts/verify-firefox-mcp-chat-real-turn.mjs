#!/usr/bin/env node
// One real ordinary Codex turn, submitted through the rendered Chat composer.
// Main explicitly selects the real bridge and grants runtime go before this CLI.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { assertRealTurnArtifact } from './egdesk-chat-qa-contract.sys.mjs';
import { attributeSelector, chatIdentity, chrome, loopbackJson, newQaThread, observeChatEvents,
  runUiFlow, sendFromComposer, visible, waitUntil } from './egdesk-qa-ui-flow.mjs';

if (process.env.EGDESK_QA_REAL_TURN !== '1' || process.env.EGDESK_QA_FIXTURE_TRANSPORT === '1') {
  throw new Error('Real Chat UI test requires EGDESK_QA_REAL_TURN=1 with fixture transport disabled');
}

await runUiFlow('rendered-ui-real-codex-artifact', async ({ harness, check, capture, result }) => {
  const manifest = assertQaFixtureManifest(harness.profile);
  check('bootstrap provides an empty dedicated real-turn cwd', !!manifest.realTurnCwd && fs.readdirSync(manifest.realTurnCwd).length === 0);
  const health = await loopbackJson('/health');
  check('real helper is ready and is not the fixture transport', health.ok === true && health.appServerReady === true && health.fixture !== true);
  const auth = (await loopbackJson('/v1/state')).auth;
  check('existing bridge authentication is ready', auth?.isLoggedIn === true && auth.loginInProgress !== true);
  const fixtureProbe = await fetch('http://127.0.0.1:39218/__qa/state', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  check('real bridge exposes no fixture control endpoint', fixtureProbe.status === 404);

  const nonce = randomBytes(6).toString('hex');
  const thread = await newQaThread(harness, `QA real file ${nonce}`);
  const configured = await chrome(harness, ({ threadId, cwd }) => {
    const api = window.__egdesk;
    const thread = api.state.codex.threads.find(item => item.id === threadId);
    if (!thread || thread.conversationId || thread.profileEnabled === true) throw new Error('Real QA thread must be new and ordinary');
    // Deliberate test context, not a transport replacement or persona injection.
    thread.cwd = cwd;
    const runtime = api.codexBridge.threadRuntimeConfig(threadId);
    const module = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
    const reflected = module.buildChatRequest(thread, 'QA request reflection; not sent', 'qa-reflection-not-sent', runtime);
    return { cwd: reflected.cwd || null, profileEnabled: reflected.profileEnabled,
      clientThreadId: reflected.clientThreadId,
      personaFields: ['agentProfile', 'systemPrompt', 'toolMode'].filter(field => Object.hasOwn(reflected, field)) };
  }, { threadId: thread.id, cwd: manifest.realTurnCwd });
  result.preflightCwd = { requested: manifest.realTurnCwd, reflected: configured.cwd };
  check('normal UI request forwards the manifest-bound cwd before any send', configured.cwd === manifest.realTurnCwd);
  check('real UI request is ordinary Codex with no persona fields', configured.profileEnabled === false && configured.personaFields.length === 0);

  const filename = `egdesk-real-${nonce}.txt`;
  const target = path.join(manifest.realTurnCwd, filename);
  const token = `EGDESK_REAL_UI_${nonce}`;
  check('requested output file does not yet exist', !fs.existsSync(target));
  const prompt = `This is an authorized local developer QA task. Work only in ${manifest.realTurnCwd}. Use apply_patch to add exactly one new UTF-8 text file at ${target}, containing exactly ${token} followed by one newline. This file is expected not to exist. If it already exists, stop without replacing or editing it. Do not create, read, change, or delete any other files. Do not use websites, accounts, external services, or unrelated commands. In your final answer include this explicit absolute Markdown link: [QA text file](${target}).`;
  const before = await chrome(harness, () => ({ cards: [...document.querySelectorAll('.egd-canvas-card')].map(node => node.id).sort(),
    pan: { ...window.__egdesk.state.panTarget }, zoom: window.__egdesk.state.zoomTarget }));
  const observation = await observeChatEvents(thread.wireClientThreadId);
  try {
    await sendFromComposer(harness, prompt);
    result.providerTurn = 'real-codex-submitted';
    const identity = await waitUntil(async () => {
      if (observation.failure) throw observation.failure;
      const approval = observation.events.find(event => event.event === 'approval.required');
      if (approval) {
        result.pendingApproval = { conversationId: approval.conversationId, runId: approval.runId,
          approvalId: approval.details?.approval?.approvalId || approval.details?.approvalId };
        throw new Error('Real turn needs Main/user approval; no approval response was sent');
      }
      const started = observation.events.find(event => event.event === 'run.started');
      const ui = await chatIdentity(harness);
      if (!started && ui.sendError) throw new Error('UI rejected the real send before a native run became observable');
      return started;
    }, Boolean, { timeoutMs: 120000 });
    result.nativeIdentity = { conversationId: identity.conversationId, runId: identity.runId, answerId: identity.answerId, requestId: identity.requestId };
    check('event identities belong to one actual Codex run', identity.answerId === `${identity.conversationId}/${identity.runId}` && !identity.runId.startsWith('qa-'));
    await visible(harness, `[data-testid="chat-run-status"]${attributeSelector('data-run-id', identity.runId)}`);
    await capture('real-turn-started');
    const state = await waitUntil(async () => {
      const snapshot = await loopbackJson(`/chat/state?conversationId=${encodeURIComponent(identity.conversationId)}`);
      const run = snapshot.runs.find(item => item.runId === identity.runId);
      if (run?.pendingApprovals?.some(item => item.status === 'pending')) {
        result.pendingApproval = { conversationId: identity.conversationId, runId: identity.runId,
          approvalId: run.pendingApprovals[0].approvalId };
        throw new Error('Real turn needs Main/user approval; no approval response was sent');
      }
      if (run && ['failed', 'interrupted'].includes(run.status)) throw new Error(`Real Codex run ended as ${run.status}`);
      return { snapshot, run };
    }, value => value.run?.status === 'completed', { timeoutMs: 180000, intervalMs: 500 });
    result.providerTurn = 'real-codex-completed';
    result.historyTruncated = state.snapshot.truncated === true;
    check('native completed run created exactly the requested file in the dedicated cwd',
      fs.existsSync(target) && JSON.stringify(fs.readdirSync(manifest.realTurnCwd)) === JSON.stringify([filename]) &&
      fs.readFileSync(target, 'utf8') === `${token}\n`);
    const artifact = state.run.artifacts.find(item => item.target?.path === target);
    check('completed run exposes a structured file reference', !!artifact);
    assertRealTurnArtifact(harness.profile, artifact);
    check('artifact identity binds to this answer without claiming creation provenance', artifact.runId === identity.runId && artifact.conversationId === identity.conversationId && artifact.answerId === identity.answerId && artifact.relation === 'referenced');
    const answer = state.run.messages.filter(item => item.role === 'assistant').map(item => item.text ?? item.content ?? '').join('\n');
    check('native answer contains an explicit absolute Markdown file link', answer.includes(`](${target})`) || answer.includes(`](<${target}>)`));
    await visible(harness, `[data-testid="chat-artifact"]${attributeSelector('data-artifact-id', artifact.id)}`);
    const after = await chrome(harness, () => ({ cards: [...document.querySelectorAll('.egd-canvas-card')].map(node => node.id).sort(),
      pan: { ...window.__egdesk.state.panTarget }, zoom: window.__egdesk.state.zoomTarget }));
    check('the completed answer did not auto-open a card or move the camera', JSON.stringify(before) === JSON.stringify(after));
    await harness.click('[data-testid="chat-activity-open"]');
    await harness.click('[aria-label="활동 상태 다시 확인"]');
    await waitUntil(() => chrome(harness, () => window.__egdesk.state.codex.threads.find(item => item.id === window.__egdesk.state.codex.activeThreadId)?.resuming === true), value => !value);
    await harness.click('[aria-label="활동 기록 닫기"]');
    const userCount = await chrome(harness, (text) => {
      const codex = window.__egdesk.state.codex;
      const thread = codex.threads.find(item => item.id === codex.activeThreadId);
      return [...document.querySelectorAll('[data-testid="chat-message"][data-role="user"]')]
        .filter(node => thread.messages.find(message => message.id === node.dataset.messageId)?.content === text).length;
    }, prompt);
    check('native/local user messages remain one row after state hydration', userCount === 1);
    await capture('real-turn-completed');
    await harness.click(`[data-testid="chat-artifact"]${attributeSelector('data-artifact-id', artifact.id)}`);
    await waitUntil(() => chrome(harness, (file) => [...document.querySelectorAll('.egd-browser-card')].some(card => {
      const uri = card._browserState?.uri || card._sourceRef?.uri || '';
      try { return decodeURIComponent(new URL(uri).pathname) === file; } catch { return false; }
    }), target), Boolean);
    await waitUntil(() => chrome(harness, async ({ file, token }) => {
      const card = [...document.querySelectorAll('.egd-browser-card')].find(card => {
        try { return decodeURIComponent(new URL(card._browserState?.uri || card._sourceRef?.uri || '').pathname) === file; } catch { return false; }
      });
      if (!card) return false;
      try { return JSON.stringify(await window.__egdesk.browserAgent.snapshot(card.id)).includes(token); }
      catch { return false; }
    }, { file: target, token }), Boolean);
    check('explicit artifact click rendered the generated file contents in Canvas', true);
    check('only one native turn was observed for the UI send', new Set(observation.events.filter(event => event.event === 'run.started').map(event => event.runId)).size === 1);
    result.artifact = { id: artifact.id, path: target, relation: artifact.relation, verifiedAt: artifact.verifiedAt };
    await capture('real-artifact-canvas-open');
  } finally {
    await observation.close();
  }
});
