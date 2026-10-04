#!/usr/bin/env node
// Real rendered UI driven by an explicitly selected test HTTP/SSE transport.
// Main owns both fixture-server and Firefox startup/shutdown.
import { assertFreshAccountRoom, assertOrdinarySend, assertPlainRenderedMessage, assertQaFixtureArtifact } from './egdesk-chat-qa-contract.sys.mjs';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { attributeSelector, chatIdentity, chrome, loopbackJson, newQaThread,
  runUiFlow, selectQaThread, sendFromComposer, visible, waitUntil } from './egdesk-qa-ui-flow.mjs';

const token = process.env.EGDESK_QA_FIXTURE_TOKEN || '';
if (process.env.EGDESK_QA_FIXTURE_TRANSPORT !== '1' || token.length < 16) {
  throw new Error('Rendered fixture test requires explicit fixture transport opt-in and its token');
}

async function canvasState(harness) {
  return chrome(harness, () => ({ cards: [...document.querySelectorAll('.egd-canvas-card')].map((node) => node.id).sort(),
    pan: { ...window.__egdesk.state.panTarget }, zoom: window.__egdesk.state.zoomTarget }));
}

async function messages(harness) {
  return chrome(harness, () => {
    const codex = window.__egdesk.state.codex;
    const thread = codex.threads.find(item => item.id === codex.activeThreadId);
    return [...document.querySelectorAll('[data-testid="chat-message"]')].map((node) => ({
    id: node.dataset.messageId, role: node.dataset.role, runId: node.dataset.runId,
    rawText: thread?.messages.find(item => item.id === node.dataset.messageId)?.content ?? null,
    text: node.querySelector('.egd-codex-bubble-content')?.innerText || '',
    rowRight: node.getBoundingClientRect().right,
    bubbleRight: node.querySelector('.egd-codex-bubble')?.getBoundingClientRect().right,
    }));
  });
}

await runUiFlow('rendered-ui-fixture-transport', async ({ harness, check, capture, result, defer }) => {
  result.providerTurn = 'fixture-only';
  assertQaFixtureManifest(harness.profile);
  const fixtureState = async () => {
    const state = await loopbackJson('/__qa/state', { token });
    if (state.fixture !== true || state.profile !== harness.profile) throw new Error('Fixture server is not bound to this Firefox test profile');
    return state;
  };
  const control = async (route, body) => {
    await fixtureState();
    return loopbackJson(route, { method: 'POST', token, body });
  };
  await waitUntil(fixtureState, (state) => state.clients > 0);
  const initialFixture = await fixtureState();
  check('fixture server has no prior sends from another test', initialFixture.observed.sends.length === 0);
  await chrome(harness, () => { window.__egdeskQaTransportIdentity = { fetch: window.fetch, EventSource: window.EventSource }; return true; });
  defer(async () => {
    const untouched = await chrome(harness, () => {
      const original = window.__egdeskQaTransportIdentity;
      const same = !!original && original.fetch === window.fetch && original.EventSource === window.EventSource;
      delete window.__egdeskQaTransportIdentity;
      return same;
    });
    check('fixture flow leaves the original fetch and EventSource intact', untouched);
  });
  const nonce = Date.now().toString(36);
  const threadA = await newQaThread(harness, `QA A ${nonce}`);
  const before = await canvasState(harness);
  const completePrompt = `EGDESK_QA_COMPLETE ${nonce}`;
  await sendFromComposer(harness, completePrompt);
  let fixture = await waitUntil(fixtureState, (state) => state.runs.some((run) => run.fixtureStage === 'streaming-visible'));
  const completeRun = fixture.runs.find((run) => run.clientThreadId === threadA.wireClientThreadId);
  check('early SSE is associated with the originating UI thread', !!completeRun);
  const sendA = fixture.observed.sends.find((send) => send.runId === completeRun.runId);
  assertOrdinarySend(sendA);
  check('ordinary UI send carries explicit profileEnabled false', sendA.profileEnabled === false);
  check('native UI submits exactly once with reflected request/thread correlation IDs', fixture.observed.sends.length === 1 && !!sendA.requestId && sendA.clientThreadId === threadA.wireClientThreadId);
  const early = fixture.observed.events.find((event) => event.runId === completeRun.runId && event.event === 'run.started');
  check('SSE was emitted while a subscriber existed and before POST completed', initialFixture.clients > 0 && early.ts < sendA.respondedAt);
  await visible(harness, '[data-testid="chat-stop"]');
  check('streaming text reaches rendered assistant bubble', (await messages(harness)).some((message) => message.role === 'assistant' && message.text.includes('Fixture reply begins.')));
  await control('/__qa/delta', { runId: completeRun.runId, delta: 'QA-LIVE-INCREMENT\n' });
  await waitUntil(() => messages(harness), rows => rows.some(row => row.role === 'assistant' && row.text.includes('QA-LIVE-INCREMENT')));
  check('a new transport delta updates the same rendered assistant item',
    (await messages(harness)).filter(row => row.role === 'assistant').length === 1 &&
    (await messages(harness)).find(row => row.role === 'assistant').text.split('QA-LIVE-INCREMENT').length === 2);
  const rawAfterDelta = (await fixtureState()).runs.find(run => run.runId === completeRun.runId).messages.find(message => message.role === 'assistant');
  const renderedAfterDelta = (await messages(harness)).find(message => message.id === rawAfterDelta.id);
  assertPlainRenderedMessage(rawAfterDelta.text, renderedAfterDelta.rawText, renderedAfterDelta.text);
  check('native/UI raw text is exact and every rendered line is preserved', true);
  await harness.click('[data-testid="chat-activity-open"]');
  const activities = await visible(harness, '.egd-codex-activity-row');
  check('activity is rendered while the run is active', activities.some((node) => node.dataset.status === 'inProgress'));
  await capture('fixture-streaming-activity');
  await harness.click('[aria-label="활동 기록 닫기"]');
  const scroll = await harness.scrollWithKey('.egd-codex-messages', 'auto');
  check('native key scroll moves the focused overflowing message log in a direction with room', scroll.overflow && scroll.focused && scroll.moved, scroll);
  await harness.scrollWithKey('.egd-codex-messages', 'End');

  await control('/__qa/release', { runId: completeRun.runId, phase: 'message' });
  await visible(harness, '[data-testid="chat-artifact"]');
  const statusAfterMessage = (await harness.inspect('[data-testid="chat-run-status"]'))[0];
  check('message.completed keeps the run active until its own completion event', statusAfterMessage.dataset.status !== 'completed' && statusAfterMessage.dataset.stopConfirmed !== 'true');
  const afterEvents = await canvasState(harness);
  check('stream/activity/artifact events create no background cards and do not move the camera', JSON.stringify(before) === JSON.stringify(afterEvents));
  await control('/__qa/release', { runId: completeRun.runId, phase: 'run' });
  await waitUntil(() => harness.inspect('[data-testid="chat-run-status"]'), (nodes) => nodes[0]?.dataset.status === 'completed');
  fixture = await fixtureState();
  const artifact = fixture.runs.find((run) => run.runId === completeRun.runId).artifacts[0];
  assertQaFixtureArtifact(harness.profile, artifact);
  await control('/__qa/replay', {});
  const beforeReconnect = await fixtureState();
  await control('/__qa/reconnect', {});
  await waitUntil(fixtureState, (state) => state.clients > 0 && state.observed.resumes.length > beforeReconnect.observed.resumes.length);
  await waitUntil(() => messages(harness), (rows) => rows.some((row) => row.role === 'assistant'));
  const hydrated = await messages(harness);
  const userRows = hydrated.filter((row) => row.role === 'user' && row.rawText === completePrompt);
  check('native user plus local optimistic user hydrate into one rendered user message', userRows.length === 1);
  check('user bubble remains right aligned', Math.abs(userRows[0].rowRight - userRows[0].bubbleRight) <= 2);
  check('event replay does not duplicate the assistant item or streamed text',
    hydrated.filter((row) => row.role === 'assistant').length === 1 &&
    hydrated.find((row) => row.role === 'assistant').text.split('Fixture reply begins.').length === 2);
  const hydratedAssistant = hydrated.find(row => row.id === rawAfterDelta.id);
  assertPlainRenderedMessage(rawAfterDelta.text, hydratedAssistant.rawText, hydratedAssistant.text);
  check('hydration preserves the complete raw and visible assistant message', true);
  await harness.click(`[data-testid="chat-artifact"]${attributeSelector('data-artifact-id', artifact.id)}`);
  const openedFile = await chrome(harness, (filePath) => [...document.querySelectorAll('.egd-browser-card')].some((card) => {
    const uri = card._browserState?.uri || card._sourceRef?.uri || '';
    try { return decodeURIComponent(new URL(uri).pathname) === filePath; } catch { return false; }
  }), artifact.target.path);
  check('explicit artifact click opens the verified temporary file on Canvas', openedFile);
  await waitUntil(() => chrome(harness, async (filePath) => {
    const card = [...document.querySelectorAll('.egd-browser-card')].find(card => {
      try { return decodeURIComponent(new URL(card._browserState?.uri || card._sourceRef?.uri || '').pathname) === filePath; } catch { return false; }
    });
    if (!card) return false;
    try { return JSON.stringify(await window.__egdesk.browserAgent.snapshot(card.id)).includes('EG-Desk deterministic QA fixture reference only.'); }
    catch { return false; }
  }, artifact.target.path), Boolean);
  check('fixture artifact contents are rendered in its Canvas Browser view', true);
  await capture('fixture-artifact-open');

  const threadB = await newQaThread(harness, `QA B ${nonce}`);
  const ordinaryPrompt = `EGDESK_QA_TEXT_ONLY ${nonce}`;
  await sendFromComposer(harness, ordinaryPrompt);
  fixture = await waitUntil(fixtureState, (state) => state.runs.some((run) => run.clientThreadId === threadB.wireClientThreadId && run.status === 'completed'));
  const ordinaryRun = fixture.runs.find((run) => run.clientThreadId === threadB.wireClientThreadId);
  await waitUntil(() => harness.inspect('[data-testid="chat-run-status"]'), (nodes) => nodes[0]?.dataset.status === 'completed');
  check('ordinary text produces no structured artifact or rendered artifact chip', ordinaryRun.artifacts.length === 0 && (await harness.inspect('[data-testid="chat-artifact"]')).length === 0);
  await selectQaThread(harness, threadA);
  check('thread A retains only its own user message', (await messages(harness)).some((row) => row.rawText === completePrompt) && !(await messages(harness)).some((row) => row.rawText === ordinaryPrompt));
  await selectQaThread(harness, threadB);
  check('thread B retains only its own user message', (await messages(harness)).some((row) => row.rawText === ordinaryPrompt) && !(await messages(harness)).some((row) => row.rawText === completePrompt));

  await sendFromComposer(harness, `EGDESK_QA_REJECT ${nonce}`);
  await waitUntil(() => chatIdentity(harness), identity => !!identity.sendError);
  await harness.fill('[data-testid="chat-composer"]', 'QA unsent draft after definite rejection');
  check('definite 503 rejection leaves the composer able to send a later request', !(await harness.inspect('[data-testid="chat-send"]'))[0].disabled);
  await sendFromComposer(harness, `EGDESK_QA_AMBIGUOUS ${nonce}`);
  await visible(harness, '[data-testid="chat-reconcile"]');
  await harness.fill('[data-testid="chat-composer"]', 'QA unsent draft during reconciliation');
  check('ambiguous transport failure stays blocked pending explicit reconciliation', (await harness.inspect('[data-testid="chat-send"]'))[0].disabled);
  await harness.click('[data-testid="chat-reconcile"]');
  await waitUntil(() => harness.inspect('[data-testid="chat-send"]'), nodes => nodes[0] && !nodes[0].disabled);
  await harness.fill('[data-testid="chat-composer"]', '');
  await capture('fixture-rejection-reconcile');

  await sendFromComposer(harness, `EGDESK_QA_STOP ${nonce}`);
  fixture = await waitUntil(fixtureState, (state) => state.runs.some((run) => run.clientThreadId === threadB.wireClientThreadId && run.status === 'running'));
  const stopRun = fixture.runs.findLast((run) => run.clientThreadId === threadB.wireClientThreadId);
  await control('/__qa/history', { partial: true });
  await harness.click('[data-testid="chat-activity-open"]');
  await harness.click('[aria-label="활동 상태 다시 확인"]');
  await visible(harness, '[data-testid="chat-history-status"][data-complete="false"]');
  await control('/__qa/delta', { runId: stopRun.runId, delta: ' QA-RESUMED-DELTA' });
  await waitUntil(() => messages(harness), rows => rows.some(row => row.runId === stopRun.runId && row.text.includes('QA-RESUMED-DELTA')));
  check('resumed active message accepts later deltas without duplication',
    (await messages(harness)).filter(row => row.role === 'assistant' && row.runId === stopRun.runId).length === 1);
  const rawResumed = (await fixtureState()).runs.find(run => run.runId === stopRun.runId).messages.find(message => message.role === 'assistant');
  const renderedResumed = (await messages(harness)).find(row => row.id === rawResumed.id);
  assertPlainRenderedMessage(rawResumed.text, renderedResumed.rawText, renderedResumed.text);
  await capture('fixture-partial-history-active-delta');
  await harness.click('[aria-label="활동 기록 닫기"]');
  await control('/__qa/history', { partial: false });
  await control('/__qa/auth-refresh', { fail: true });
  await control('/__qa/reconnect', {});
  await waitUntil(fixtureState, (state) => state.clients > 0);
  await visible(harness, '[data-testid="chat-stop"]');
  await harness.click('[data-testid="chat-stop"]');
  await waitUntil(fixtureState, (state) => state.runs.find((run) => run.runId === stopRun.runId)?.stopRequested);
  const stopping = (await harness.inspect('[data-testid="chat-run-status"]'))[0];
  const stopButton = (await harness.inspect('[data-testid="chat-stop"]'))[0];
  check('stop acknowledgement disables the button without claiming interrupted', stopButton.disabled && stopping.dataset.stopConfirmed === 'false' && stopping.dataset.status !== 'interrupted');
  await capture('fixture-stop-requested');
  await control('/__qa/release', { runId: stopRun.runId, phase: 'run' });
  await waitUntil(() => harness.inspect('[data-testid="chat-run-status"]'), (nodes) => nodes[0]?.dataset.stopConfirmed === 'true');
  check('one explicit stop targets the active conversation and run', (await fixtureState()).observed.interrupts.length === 1);
  await control('/__qa/auth-refresh', { fail: false });

  await sendFromComposer(harness, `EGDESK_QA_APPROVAL ${nonce}`);
  fixture = await waitUntil(fixtureState, (state) => state.runs.some((run) => run.pendingApprovals.length));
  const approvalRun = fixture.runs.find((run) => run.pendingApprovals.length);
  const approval = approvalRun.pendingApprovals[0];
  await harness.click('[data-testid="chat-activity-open"]');
  await visible(harness, '[data-testid="chat-approval"]');
  check('approval is not answered automatically and proposed paths are not artifacts', fixture.observed.approvals.length === 0 && (await harness.inspect('[data-testid="chat-artifact"]')).length === 0);
  const choices = await harness.inspect('[data-testid="chat-approval-choice"]');
  check('rendered choices are exactly those offered by the pending approval', JSON.stringify(choices.map((node) => node.dataset.decision).sort()) === JSON.stringify([...approval.choices].sort()));
  await harness.click(`[data-testid="chat-approval-choice"][data-decision="decline"]${attributeSelector('data-approval-id', approval.approvalId)}`);
  await waitUntil(() => harness.inspect('[data-testid="chat-approval"]'), (nodes) => nodes[0]?.dataset.status === 'replySent');
  check('replySent disables every approval choice while the run stays active',
    (await harness.inspect('[data-testid="chat-approval-choice"]')).every((node) => node.disabled) &&
    (await fixtureState()).runs.find((run) => run.runId === approvalRun.runId).status === 'running');
  await capture('fixture-approval-reply-sent');
  await control('/__qa/release', { runId: approvalRun.runId, phase: 'approval' });
  await waitUntil(() => harness.inspect('[data-testid="chat-approval"]'), (nodes) => nodes.length === 0);
  await control('/__qa/release', { runId: approvalRun.runId, phase: 'run' });
  await harness.click('[aria-label="활동 기록 닫기"]');
  await waitUntil(() => harness.inspect('[data-testid="chat-run-status"]'), (nodes) => nodes[0]?.dataset.status === 'completed');

  const threadC = await newQaThread(harness, `QA retry ${nonce}`);
  const retryPrompt = `EGDESK_QA_START_FAIL ${nonce}`;
  await sendFromComposer(harness, retryPrompt);
  fixture = await waitUntil(fixtureState, (state) => state.observed.sends.some((send) => send.clientThreadId === threadC.wireClientThreadId && send.outcome === 'turn-start-rejected'));
  await visible(harness, '.egd-codex-error');
  const failedSend = fixture.observed.sends.find((send) => send.clientThreadId === threadC.wireClientThreadId);
  const failedIdentity = await chatIdentity(harness);
  check('failed first send retains the native conversation in the same UI Chat', failedIdentity.conversationId === failedSend.createdConversationId && failedIdentity.threadId === threadC.id);
  await sendFromComposer(harness, retryPrompt);
  fixture = await waitUntil(fixtureState, (state) => state.runs.some((run) => run.clientThreadId === threadC.wireClientThreadId && run.status === 'completed'));
  const attempts = fixture.observed.sends.filter((send) => send.clientThreadId === threadC.wireClientThreadId);
  check('explicit retry uses the returned native conversation and creates no unrelated conversation',
    attempts.length === 2 && attempts[1].conversationId === failedSend.createdConversationId);
  await capture('fixture-first-send-retry');

  await sendFromComposer(harness, `EGDESK_QA_LOST ${nonce}`);
  const lost = await waitUntil(() => harness.inspect('[data-testid="chat-run-status"]'), (nodes) => nodes[0]?.dataset.status === 'failed');
  const identity = await chatIdentity(harness);
  const terminal = await loopbackJson(`/chat/state?conversationId=${encodeURIComponent(identity.conversationId)}`);
  check('runtime loss is offline/failed with RUNTIME_LOST and never a confirmed stop',
    terminal.connection === 'offline' && terminal.runs.some((run) => run.error?.code === 'RUNTIME_LOST') && lost[0].dataset.stopConfirmed === 'false');
  await capture('fixture-runtime-lost');

  await control('/__qa/runtime-ready', {});
  const accountThread = await newQaThread(harness, `QA same-provider account ${nonce}`);
  await sendFromComposer(harness, `EGDESK_QA_STOP account-a-${nonce}`);
  const accountA = await waitUntil(fixtureState, state => state.runs.some(run => run.clientThreadId === accountThread.wireClientThreadId && run.status === 'running'));
  const accountARun = accountA.runs.find(run => run.clientThreadId === accountThread.wireClientThreadId);
  await control('/__qa/account-change', { variant: 'b' });
  const rotated = await waitUntil(() => chrome(harness, ({ id, previousBinding }) => {
    const api = window.__egdesk;
    const thread = api.state.codex.threads.find(item => item.id === id);
    const module = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
    const reflected = thread && module.buildChatRequest(thread, 'QA reflection; not sent', 'qa-account-reflection', api.codexBridge.threadRuntimeConfig(id));
    const protocol = api.state.codex.chatProtocol;
    return { localId: thread?.id, binding: reflected?.clientThreadId, conversationId: thread?.conversationId || null,
      genericIdUnchanged: api.state.codex.authStatus.accountId === 'chatgpt',
      syntheticEmailB: api.state.codex.authStatus.accountEmail === 'qa-account-b@egdesk.invalid',
      bindingRotated: !!reflected?.clientThreadId && reflected.clientThreadId !== previousBinding,
      runs: Object.keys(protocol.runs).length, requests: Object.keys(protocol.requests).length,
      previousRunUnconfirmed: protocol.unobservedPreviousRun === true };
  }, { id: accountThread.id, previousBinding: accountThread.wireClientThreadId }),
  value => value.syntheticEmailB && value.bindingRotated && value.runs === 0 && value.requests === 0);
  check('email A to B resets the same-provider account despite generic accountId chatgpt',
    rotated.genericIdUnchanged && rotated.localId === accountThread.id && !rotated.conversationId && rotated.previousRunUnconfirmed);
  await selectQaThread(harness, accountThread);
  await visible(harness, '[data-testid="chat-binding-held"]');
  const retained = await chrome(harness, (id) => {
    const thread = window.__egdesk.state.codex.threads.find(item => item.id === id);
    return { reference: thread.retainedNativeBinding,
      rawMessages: thread.messages.map(message => message.content) };
  }, accountThread.id);
  check('held account-A room retains its transcript and old native reference',
    retained.reference?.conversationId === accountARun.conversationId &&
    retained.reference?.clientThreadId === accountThread.wireClientThreadId &&
    retained.rawMessages.includes(`EGDESK_QA_STOP account-a-${nonce}`));
  await harness.fill('[data-testid="chat-composer"]', 'QA unsent draft in retained account-A room');
  check('held transcript cannot submit under account B', (await harness.inspect('[data-testid="chat-send"]'))[0].disabled);
  await harness.click('[data-testid="chat-new-unbound-room"]');
  await visible(harness, '[data-testid="chat-composer"]');
  const accountBRoom = await chrome(harness, () => {
    const api = window.__egdesk;
    const thread = api.state.codex.threads.find(item => item.id === api.state.codex.activeThreadId);
    const module = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
    const reflected = module.buildChatRequest(thread, 'QA reflection; not sent', 'qa-new-account-reflection', api.codexBridge.threadRuntimeConfig(thread.id));
    return { localThreadId: thread.id, wireClientThreadId: reflected.clientThreadId,
      conversationId: thread.conversationId || null, messageCount: thread.messages.length,
      bindingHeld: module.nativeBindingHeld(thread), profileEnabled: reflected.profileEnabled };
  });
  assertFreshAccountRoom({ localThreadId: accountThread.id, wireClientThreadId: accountThread.wireClientThreadId }, accountBRoom);
  check('explicit New Codex conversation creates an empty unbound account-B room', true);
  await sendFromComposer(harness, `EGDESK_QA_TEXT_ONLY account-b-${nonce}`);
  const accountB = await waitUntil(fixtureState, state => state.runs.some(run => run.clientThreadId === accountBRoom.wireClientThreadId && run.status === 'completed'));
  const accountBRun = accountB.runs.find(run => run.clientThreadId === accountBRoom.wireClientThreadId);
  check('new-room UI send uses a fresh account binding and conversation',
    accountBRun.conversationId !== accountARun.conversationId && accountBRun.clientThreadId !== accountThread.wireClientThreadId);
  check('account-change fixture required no logout request', accountB.observed.authWrites.length === 0);
  await capture('fixture-same-id-email-account-change');

  const authThread = await newQaThread(harness, `QA auth reset ${nonce}`);
  await sendFromComposer(harness, `EGDESK_QA_STOP auth-reset-${nonce}`);
  await waitUntil(fixtureState, state => state.runs.some(run => run.clientThreadId === authThread.wireClientThreadId && run.status === 'running'));
  await control('/__qa/auth-diagnostics', {});
  await visible(harness, '.egd-codex-diagnostics-toggle');
  if (!(await harness.inspect('.egd-codex-diagnostics')).some(node => node.visible)) await harness.click('.egd-codex-diagnostics-toggle');
  const signoutSelector = '.egd-codex-diagnostics-actions button:last-child';
  check('fixture logout control is the actual rendered logout button', (await harness.inspect(signoutSelector))[0]?.text === '로그아웃');
  await control('/__qa/hold-resume', { hold: true });
  await harness.click('[data-testid="chat-activity-open"]');
  const heldBefore = (await fixtureState()).observed.heldResumes;
  await harness.click('[aria-label="활동 상태 다시 확인"]');
  await waitUntil(fixtureState, state => state.observed.heldResumes > heldBefore);
  await harness.click('[aria-label="활동 기록 닫기"]');
  await fixtureState(); // Recheck exact fixture/profile binding immediately before logout.
  await harness.click(signoutSelector);
  const cacheState = () => chrome(harness, () => {
    const codex = window.__egdesk.state.codex;
    const protocol = codex.chatProtocol;
    return { loggedIn: codex.authStatus.isLoggedIn, runs: Object.keys(protocol.runs).length,
      requests: Object.keys(protocol.requests).length, streams: Object.keys(protocol.streams).length,
      conversations: codex.threads.filter(thread => thread.conversationId).length,
      previousRunUnconfirmed: protocol.unobservedPreviousRun === true };
  });
  const reset = await waitUntil(cacheState, state => !state.loggedIn && state.runs === 0 && state.requests === 0 && state.streams === 0);
  check('fixture logout clears protocol identities without claiming prior work stopped', reset.conversations === 0 && reset.previousRunUnconfirmed);
  await control('/__qa/release-resume', {});
  await new Promise(resolve => setTimeout(resolve, 350));
  const late = await cacheState();
  check('late pre-logout refresh cannot repopulate the cleared account cache', !late.loggedIn && late.runs === 0 && late.requests === 0 && late.streams === 0 && late.conversations === 0);
  check('only the fixture server received logout', (await fixtureState()).observed.authWrites.length === 1);
  await capture('fixture-auth-reset-late-refresh');
});
