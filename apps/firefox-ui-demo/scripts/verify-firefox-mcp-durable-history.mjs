#!/usr/bin/env node
// Attach-only acceptance for Main's already-running disposable Firefox and
// offline production bridge. Never sends a Chat request or starts a provider.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { assertPlainRenderedMessage } from './egdesk-chat-qa-contract.sys.mjs';
import { createProductionHistoryHttp } from './verify-chat-history-restart.mjs';
import { readCanonical } from './egdesk-chat-history-shape-b-qa-adapter.mjs';
import { chrome, openChat, option, runUiFlow, visible, waitUntil } from './egdesk-qa-ui-flow.mjs';

const phase = option('--phase');
if (!['before', 'after'].includes(phase)) throw new Error('--phase must be before or after');
const TEST_KIND = 'egdesk-firefox-durable-chat-reopen-v1';
const screenshotName = phase === 'before' ? 'durable-chat-before-firefox-restart' : 'durable-chat-after-firefox-restart';

function guardedJson(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() ||
      (info.mode & 0o022) !== 0 || fs.realpathSync.native(file) !== file) {
    throw new Error('QA checkpoint must be a canonical user-owned regular file');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function readRoomList(harness, ids) {
  await openChat(harness);
  if ((await harness.inspect('.egd-codex-conversation-back')).some(node => node.visible)) {
    await harness.click('.egd-codex-conversation-back');
  }
  return chrome(harness, wanted => {
    const state = window.__egdesk.state.codex;
    const present = wanted.map(id => {
      const thread = state.threads.find(item => item.id === id);
      return thread ? { id: thread.id, title: thread.title, localConversationId: thread.localConversationId,
        coverage: thread.localHistoryCoverage, messageCount: thread.messages?.length || 0 } : null;
    });
    const visible = node => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const rows = [...document.querySelectorAll('.egd-codex-thread-item')].filter(visible)
      .map(node => ({ title: node.querySelector('.egd-codex-thread-title')?.textContent?.trim() || '',
        preview: node.textContent?.trim() || '' }));
    return { status: state.localHistoryStatus, error: state.localHistoryError,
      connected: state.connected, present, rows };
  }, ids);
}

async function selectQaRoomByPreview(harness, clientThreadId, marker) {
  await visible(harness, '.egd-codex-thread-search');
  await harness.fill('.egd-codex-thread-search', marker);
  const row = await waitUntil(() => chrome(harness, wanted => {
    const visible = node => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const matches = [...document.querySelectorAll('.egd-codex-thread-item')]
      .filter(node => visible(node) && node.querySelector('.egd-codex-thread-preview')?.textContent?.includes(wanted));
    const node = matches[0];
    if (!node) return { count: 0, selector: null };
    const root = node.closest('#egd-hud, .egd-chat-card');
    if (!root?.id) throw new Error('QA Chat row has no owned surface root');
    const parts = [];
    for (let current = node; current !== root; current = current.parentElement) {
      parts.unshift(`${current.localName}:nth-child(${[...current.parentElement.children].indexOf(current) + 1})`);
    }
    return { count: matches.length, selector: `#${CSS.escape(root.id)} > ${parts.join(' > ')}` };
  }, marker), value => value.count > 0 && !!value.selector);
  await harness.click(row.selector);
  await visible(harness, '[data-testid="chat-composer"]');
  const selected = await chrome(harness, () => window.__egdesk.state.codex.activeThreadId);
  assert.equal(selected, clientThreadId, 'rendered QA preview selected a different local room');
}

async function readActiveChat(harness) {
  return chrome(harness, () => {
    const codex = window.__egdesk.state.codex;
    const thread = codex.threads.find(item => item.id === codex.activeThreadId);
    const visible = node => {
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const rendered = [...document.querySelectorAll('[data-testid="chat-message"]')].filter(visible)
      .map(node => ({ id: node.dataset.messageId, role: node.dataset.role,
        text: node.querySelector('.egd-codex-bubble-content')?.innerText || '' }));
    return { threadId: thread?.id || null, localConversationId: thread?.localConversationId || null,
      conversationId: thread?.conversationId || null, bindingState: thread?.bindingState || null,
      coverage: thread?.localHistoryCoverage || null,
      messages: (thread?.messages || []).map(item => ({ id: item.id, role: item.role,
        rawText: item.content ?? item.text ?? '', inputReferences: item.inputReferences || [],
        briefingId: item.briefing?.id || null })),
      localRuns: thread?.localRuns || [],
      draft: thread ? codex.threadDrafts[thread.id] || '' : '',
      composer: document.querySelector('[data-testid="chat-composer"]')?.value ?? null,
      rendered, briefingButtons: [...document.querySelectorAll('[data-testid="briefing-open"]')].filter(visible)
        .map(node => node.dataset.answerId),
      stopButtons: [...document.querySelectorAll('[data-testid="chat-stop"]')].filter(visible).length,
      liveRequests: Object.values(codex.chatProtocol.requests).filter(request =>
        request.clientThreadId === thread?.id || request.localThreadId === thread?.id).length,
    };
  });
}

async function readActivityRefs(harness) {
  await harness.click('[data-testid="chat-activity-open"]');
  await visible(harness, '[data-testid="chat-activity-panel"]');
  const refs = await chrome(harness, () => ({
    delivered: [...document.querySelectorAll('[data-testid="chat-delivered-input-open"]')]
      .map(node => ({ packetId: node.dataset.packetId, sourceId: node.dataset.sourceId })),
    contexts: [...document.querySelectorAll('[data-testid="chat-context-activity"]')]
      .map(node => ({ event: node.dataset.event, sourceId: node.dataset.sourceId })),
  }));
  await harness.click('[aria-label="활동 기록 닫기"]');
  return refs;
}

async function savedDraft(harness, threadId, draft) {
  return chrome(harness, value => {
    const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
    const saved = JSON.parse(services.prefs.getStringPref('egdesk.deskSession.v1', '{}'));
    return saved.chat?.threadDrafts?.[value.threadId] === value.draft;
  }, { threadId, draft });
}

await runUiFlow(`durable-history-${phase}`, async ({ harness, check, capture, result }) => {
  result.providerTurn = 'not-run; synthetic local-history import only';
  const manifest = assertQaFixtureManifest(harness.profile);
  if (!manifest.backendDataDir) throw new Error('QA profile has no manifest-bound backend-data directory');
  const httpCheckpointPath = path.join(manifest.backendDataDir, 'history-restart-checkpoint.json');
  const paginationPath = path.join(manifest.backendDataDir, 'canonical-pagination-seed.json');
  const uiCheckpointPath = path.join(manifest.root, 'firefox-durable-history-checkpoint.json');
  const httpCheckpoint = guardedJson(httpCheckpointPath);
  const pagination = guardedJson(paginationPath);
  check('HTTP seed belongs to this guarded backend', httpCheckpoint.dataDir === manifest.backendDataDir
    && pagination.dataDir === manifest.backendDataDir);
  const http = createProductionHistoryHttp();
  const health = await http.health();
  check('attached bridge is production but native Codex remains unavailable',
    health.ok === true && health.fixture !== true && health.appServerReady === false);
  const canonical = await readCanonical({ threads: http.threads, history: http.history },
    httpCheckpoint.clientThreadId);
  check('production DB still matches the sealed HTTP seed before UI actions',
    JSON.stringify(canonical) === JSON.stringify(httpCheckpoint.expected));
  const overlay = await waitUntil(() => chrome(harness, () => ({
    href: document.location.href,
    ready: !!window.__egdesk?.surface?.snapshot,
    mode: window.__egdesk?.surface?.snapshot?.().mode || null,
    hasDock: !!document.getElementById('egd-dock'),
    hasLegacyEntry: !!document.getElementById('egd-desk-entry'),
  })), value => value.ready && (value.hasDock || value.hasLegacyEntry), { timeoutMs: 30000 });
  result.overlayBoot = { mode: overlay.mode, hasDock: overlay.hasDock,
    hasLegacyEntry: overlay.hasLegacyEntry };
  // Temporary access only while the old onboarding is still present. This is
  // not an acceptance assertion for the canvas-first Browser/Desk flow.
  const surfaceMode = overlay.mode;
  const legacyEntry = surfaceMode === 'browser'
    && (await harness.inspect('#egd-desk-entry')).some(node => node.visible);
  if (legacyEntry) {
    await harness.click('#egd-desk-entry');
    await waitUntil(() => chrome(harness, () => window.__egdesk.surface.snapshot().mode),
      value => value === 'desk');
    result.provisionalLegacyDeskEntryUsed = true;
  }
  result.onboardingAcceptance = 'not-tested; canvas-first Browser/Desk flow remains pending';
  await visible(harness, '#egd-dock');
  const ids = [httpCheckpoint.clientThreadId, pagination.clientThreadId];
  const rooms = await waitUntil(() => readRoomList(harness, ids), value =>
    value.status === 'ready' && value.present.every(Boolean) && value.rows.length >= 2);
  check('both DB-only rooms are restored into the rendered Chat list while offline', rooms.present.every(room =>
    room?.localConversationId && rooms.rows.some(row => row.title === room.title)));
  check('canonical pagination room kept complete local coverage',
    rooms.present[1]?.coverage?.status === 'complete' && rooms.present[1]?.coverage?.nativeHistoryComplete === null);
  const target = rooms.present[0];
  const expected = httpCheckpoint.expected;
  const messageIds = canonical.messages.map(message => ({
    nativeId: message.id, localId: message.localMessageId, role: message.role,
  }));
  check('current HTTP history maps each native message ID to one canonical local message ID',
    messageIds.length === expected.messages.length
      && messageIds.every(item => typeof item.nativeId === 'string' && !!item.nativeId
        && typeof item.localId === 'string' && !!item.localId)
      && new Set(messageIds.map(item => item.nativeId)).size === messageIds.length
      && new Set(messageIds.map(item => item.localId)).size === messageIds.length);
  const localIdFor = message => messageIds.find(item =>
    item.nativeId === message.id && item.role === message.role)?.localId;
  const marker = expected.messages.find(message => message.role === 'assistant')?.rawText.split(/\s/)[0];
  if (!marker?.startsWith('EGDESK_QA_HISTORY_')) throw new Error('Seeded Chat has no unique synthetic row marker');
  await selectQaRoomByPreview(harness, target.id, marker);
  const active = await waitUntil(() => readActiveChat(harness), value =>
    value.threadId === target.id && expected.messages.every(message =>
      value.messages.some(item => item.id === localIdFor(message) && item.rawText === message.rawText)));
  check('imported room retains exact local ID and complete coverage without native resume',
    active.localConversationId === expected.thread.localConversationId && active.conversationId === null
      && active.coverage?.status === 'complete');
  for (const message of expected.messages) {
    const localId = localIdFor(message);
    const stored = active.messages.filter(item => item.id === localId && item.role === message.role);
    const rendered = active.rendered.filter(item => item.id === localId && item.role === message.role);
    check(`exact visible ${message.role} message ${localId} appears once`, stored.length === 1 && rendered.length === 1);
    assertPlainRenderedMessage(message.rawText, stored[0].rawText, rendered[0].text);
  }
  const sourceIds = expected.attachmentRefs.map(item => item.sourceId);
  const briefingIds = expected.briefingRefs.map(item => item.id);
  check('immutable attachment and Briefing refs survive in local run history',
    sourceIds.every(id => active.localRuns.some(run => (run.contextCaptures || []).some(ref => ref.sourceId === id)))
      && briefingIds.every(id => active.localRuns.some(run => run.briefing?.id === id)));
  const activityRefs = await readActivityRefs(harness);
  const packetIds = expected.runs.flatMap(run => (run.contextEvents || [])
    .map(event => event.details?.packetId).filter(Boolean));
  check('past source and packet reference remains available in rendered activity',
    sourceIds.every(id => activityRefs.contexts.some(ref => ref.sourceId === id))
      && packetIds.every(id => activityRefs.delivered.some(ref => ref.packetId === id)));
  check('Briefing reference has a visible Chat control',
    expected.briefingRefs.every(ref => active.briefingButtons.includes(ref.answerId)), {
      expectedAnswerIds: expected.briefingRefs.map(ref => ref.answerId),
      renderedButtonAnswerIds: active.briefingButtons,
      assistantMessageBriefingIds: active.messages.filter(message => message.role === 'assistant')
        .map(message => ({ id: message.id, briefingId: message.briefingId })),
      savedRunBriefingIds: active.localRuns.map(run => ({ runId: run.runId, briefingId: run.briefing?.id || null })),
    });
  check('historical local runs are not shown as live provider execution',
    active.stopButtons === 0 && active.liveRequests === 0);

  if (phase === 'before') {
    if (fs.existsSync(uiCheckpointPath)) throw new Error('UI checkpoint already exists; do not overwrite prior QA evidence');
    const draft = `EGDESK_QA_HISTORY_DRAFT_${randomBytes(6).toString('hex')}`;
    await harness.fill('[data-testid="chat-composer"]', draft);
    await waitUntil(() => readActiveChat(harness), value => value.draft === draft && value.composer === draft);
    await waitUntil(() => savedDraft(harness, target.id, draft), Boolean);
    const sealed = { kind: TEST_KIND, profile: harness.profile, dataDir: manifest.backendDataDir,
      clientThreadId: target.id, localConversationId: active.localConversationId,
      messageIds, messageRows: active.rendered, sourceIds, briefingIds, draft };
    fs.writeFileSync(uiCheckpointPath, JSON.stringify(sealed), { flag: 'wx', mode: 0o600 });
    result.restartInstruction = 'Main restarts only this QA Firefox; keep the same guarded profile and production offline bridge, then run --phase after.';
  } else {
    const sealed = guardedJson(uiCheckpointPath);
    check('UI checkpoint belongs to the same QA profile and DB', sealed.kind === TEST_KIND
      && sealed.profile === harness.profile && sealed.dataDir === manifest.backendDataDir
      && sealed.clientThreadId === target.id && sealed.localConversationId === active.localConversationId);
    check('exact rendered message rows and unsent draft returned after Firefox restart',
      JSON.stringify(active.rendered) === JSON.stringify(sealed.messageRows)
        && active.draft === sealed.draft && active.composer === sealed.draft);
    check('native-to-local message ID mapping is stable after Firefox restart',
      JSON.stringify(messageIds) === JSON.stringify(sealed.messageIds));
    check('attachment and Briefing IDs match the pre-restart UI evidence',
      JSON.stringify(sourceIds) === JSON.stringify(sealed.sourceIds)
        && JSON.stringify(briefingIds) === JSON.stringify(sealed.briefingIds));
  }
  check('UI inspection and draft editing made no provider or DB history turn',
    JSON.stringify(await readCanonical({ threads: http.threads, history: http.history },
      httpCheckpoint.clientThreadId)) === JSON.stringify(httpCheckpoint.expected));
  await capture(screenshotName);
  result.clientThreadId = target.id;
  result.localConversationId = target.localConversationId;
  result.seededRoomCount = rooms.present.length;
  result.visibleRoomCount = rooms.rows.length;
  result.refs = { attachmentSources: sourceIds.length, briefings: briefingIds.length, packets: packetIds.length };
});
