#!/usr/bin/env node
// Main owns startup. This script attaches only to the explicitly selected QA
// profile + fixture transport. It never launches Firefox or a native model.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { assertPublishedBriefing, assertContextSendBindings, assertFrozenFileReadAfterMutation,
  assertStoredAgentDelivery, captureContextReadEvidence, fingerprintQaBytes, observeQaFixtureFile } from './egdesk-context-qa-contract.mjs';
import { attributeSelector, chrome, loopbackJson, newQaThread, option, runUiFlow,
  selectQaThread, selectorForId, sendFromComposer, visible, waitUntil } from './egdesk-qa-ui-flow.mjs';

if (process.env.EGDESK_QA_FIXTURE_TRANSPORT !== '1' || process.env.EGDESK_QA_STATE_FIXTURES !== '1'
    || !process.env.EGDESK_QA_FIXTURE_TOKEN || process.env.EGDESK_QA_REAL_TURN === '1') {
  throw new Error('Context UI fixture requires explicit fixture/state opt-ins and token; native turns are forbidden');
}
const phase = option('--phase', 'core');
if (!['core', 'restored-range'].includes(phase)) throw new Error('--phase must be core or restored-range');
const token = process.env.EGDESK_QA_FIXTURE_TOKEN;
const hook = name => attributeSelector('data-testid', name);
const control = (route, body) => loopbackJson(route, { method: 'POST', body, token });
const fixtureState = () => loopbackJson('/__qa/state', { token });
const camera = harness => chrome(harness, () => ({ pan: { ...window.__egdesk.state.panTarget }, zoom: window.__egdesk.state.zoomTarget }));
const sameCamera = (a, b) => Math.abs(a.pan.x - b.pan.x) < 0.5 && Math.abs(a.pan.y - b.pan.y) < 0.5 && Math.abs(a.zoom - b.zoom) < 0.001;

await runUiFlow(`context-briefing-fixture-${phase}`, async ({ harness, check, capture, result }) => {
  result.providerTurn = 'fixture-only-no-native-provider';
  result.actions = [];
  const manifest = assertQaFixtureManifest(harness.profile);
  const health = await loopbackJson('/health');
  const initial = await fixtureState();
  check('explicit fixture transport is bound to this exact guarded profile', health.fixture === true && initial.profile === harness.profile);
  check('core input APIs are integrated before any UI test action', await chrome(harness, () =>
    !!window.__egdesk?.codexBridge?.captureInputs && !!window.__egdesk.codexBridge.readInput));
  const checkpoint = path.join(manifest.root, 'context-qa-resume.json');

  // Never retry a click. A tool acknowledgement timeout is recorded separately;
  // progress requires the unique observed postcondition of that one action.
  const clickThen = async (label, selector, read, accept) => {
    await visible(harness, selector);
    let acknowledgement = 'received';
    try { await harness.click(selector); }
    catch (error) {
      if (!/MCP tools\/call timed out/.test(error.message)) throw error;
      acknowledgement = 'timeout; action not retried';
    }
    const observed = await waitUntil(read, accept);
    result.actions.push({ label, acknowledgement, postconditionObserved: true });
    return observed;
  };
  const panel = () => chrome(harness, () => {
    const root = document.getElementById('egd-codex-input-panel');
    const article = root?.querySelector('[data-testid="chat-input-snapshot"]');
    return { exists: !!root, sourceId: article?.dataset.snapshotId || null,
      sourceText: article?.querySelector('[aria-label="당시 캡처 본문"]')?.textContent || '',
      sourceLabel: !!article?.querySelector('[data-testid="chat-input-source-label"]'),
      packetId: article?.querySelector('[data-testid="chat-input-delivery"]')?.dataset.packetId || null };
  });
  const closePanel = () => clickThen('Close inspector', '[aria-label="첨부 패널 닫기"]', panel, value => !value.exists);
  const roomState = () => chrome(harness, () => {
    const c = window.__egdesk.state.codex;
    const t = c.threads.find(item => item.id === c.activeThreadId);
    return { id: t?.id, sources: t?.inputSources || [], draft: c.threadDrafts[t?.id] || '',
      preparing: !!t?.preparingInput, error: t?.sendError || null, briefingInputs: t?.briefingInputs || [] };
  });

  if (phase === 'restored-range') {
    observeQaFixtureFile(harness.profile, checkpoint);
    const saved = JSON.parse(fs.readFileSync(checkpoint, 'utf8'));
    if (saved.profile !== harness.profile || saved.kind !== 'egdesk-context-qa-restart-v1') throw new Error('Checkpoint is not bound to this profile');
    const before = await fixtureState();
    const target = await chrome(harness, sourceId => {
      const card = [...document.querySelectorAll('.egd-input-evidence-card')].find(node =>
        node._inputReference?.sourceId === sourceId && node._inputReference?.presentationRange?.startLine === 201);
      return card && { id: card.id, reference: card._inputReference, loaded: !!card._inputEvidenceLoaded };
    }, saved.rangeSourceId);
    check('restored card retains its immutable 201–240 reference',
      target?.reference?.presentationRange?.startLine === 201 && target.reference.presentationRange.endLine === 240);
    if (await chrome(harness, () => window.__egdesk.state.hudOpen)) {
      await clickThen('Close the overlapping side panel', '#egd-hud .egd-hud-close',
        () => chrome(harness, () => window.__egdesk.state.hudOpen), value => !value);
    }
    // Normal native viewport navigation, never an API camera adjustment.
    await harness.press('Control+0');
    if (!target.loaded) await clickThen('Load the restored evidence range', `${selectorForId(target.id)} [aria-label="저장된 당시 입력 불러오기"]`,
      () => chrome(harness, id => !!document.getElementById(id)?._inputEvidenceLoaded, target.id), Boolean);
    const text = await chrome(harness, id => document.getElementById(id)?.querySelector('[aria-label="당시 캡처 본문"]')?.textContent || '', target.id);
    check('restored range renders actual lines 201–240, not a relabeled first page', text === saved.rangeText);
    const after = await fixtureState();
    const relevant = after.context.inspectorReads.filter(item => item.sourceId === saved.rangeSourceId);
    check('the observed GET requested the saved actual range', relevant.at(-1)?.startLine === 201 && relevant.at(-1)?.endLine === 240);
    const pastPacket = captureContextReadEvidence(await loopbackJson(
      `/context/captures/${saved.packetSourceId}?packetId=${encodeURIComponent(saved.packetId)}`));
    assertStoredAgentDelivery(pastPacket.delivered, { packetId: saved.packetId,
      binding: saved.fixtureIdentity, expectedToolText: saved.packetText });
    await selectQaThread(harness, saved.thread);
    await clickThen('Open restored input history', hook('chat-activity-open'),
      () => harness.inspect(hook('chat-input-history')), value => value.length > 0);
    const history = hook('chat-input-history') + attributeSelector('data-run-id', saved.fixtureIdentity.runId);
    await harness.click(`${history} summary`);
    await clickThen('Inspect the restored historical input',
      `${history} ${hook('chat-input-history-open')}${attributeSelector('data-snapshot-id', saved.packetSourceId)}`,
      panel, value => value.sourceId === saved.packetSourceId && value.sourceText === saved.packetSourceText
        && value.packetId === saved.packetId);
    await harness.click(`#egd-codex-input-panel ${hook('chat-input-delivery')} > summary`);
    const renderedPacket = await chrome(harness, () =>
      document.querySelector('#egd-codex-input-panel [aria-label="실제로 전달된 payload 원문"]')?.textContent);
    check('restored history renders the exact past packet, not a new projection', renderedPacket === saved.packetText);
    const finalState = await fixtureState();
    check('restoration created no capture or send', finalState.context.captureBatches === before.context.captureBatches
      && finalState.observed.sends.length === before.observed.sends.length);
    await capture('restored-evidence-201-240-and-past-packet');
    return;
  }

  check('full core flow begins on a fresh fixture with zero sends/captures', initial.observed.sends.length === 0 && initial.context.captureBatches === 0);
  if (await chrome(harness, () => window.__egdesk.surface.snapshot().mode === 'browser')) {
    await clickThen('Enter Desk', '#egd-desk-entry', () => chrome(harness, () => window.__egdesk.surface.snapshot().mode), value => value === 'desk');
  }
  const nonce = randomBytes(5).toString('hex');
  const originalLines = Array.from({ length: 610 }, (_, index) => `QA_FILE_V0_${nonce}_line_${index + 1}`);
  const changedLines = Array.from({ length: 610 }, (_, index) => `QA_FILE_V1_${nonce}_line_${index + 1}`);
  const sourceFile = path.join(manifest.root, `context-source-${nonce}.txt`);
  fs.writeFileSync(sourceFile, originalLines.join('\n'), { flag: 'wx', mode: 0o600 });
  const browserFile = path.join(manifest.root, `context-browser-${nonce}.html`);
  const browserText = Array.from({ length: 610 }, (_, index) => `QA_BROWSER_${nonce}_line_${index + 1}`).join('\n');
  fs.writeFileSync(browserFile, `<title>QA Browser ${nonce}</title><pre>${browserText}</pre>`, { flag: 'wx', mode: 0o600 });
  result.fixtureSource = sourceFile;
  const originalFile = observeQaFixtureFile(harness.profile, sourceFile);
  const scene = await chrome(harness, ({ fileUrl, nonce }) => {
    const api = window.__egdesk;
    // A short, fixture-only URL keeps the full 610-line content out of both
    // MCP's evaluation input and the source-location label in the picker.
    const browserUrl = `http://127.0.0.1:39218/__qa/browser-document/${nonce}`;
    const file = api.cardRuntime.openBrowserCard(fileUrl, { openMode: 'new' });
    const browser = api.cardRuntime.openBrowserCard(browserUrl, { openMode: 'new' });
    const longText = Array.from({ length: 610 }, (_, index) => `QA_LONG_URL_${nonce}_line_${index + 1}`).join('\n');
    const longUrl = `data:text/html;charset=utf-8,${encodeURIComponent(`<title>QA long URL ${nonce}</title><pre>${longText}</pre>`)}`;
    const longBrowser = api.cardRuntime.openBrowserCard(longUrl, { openMode: 'new' });
    for (const [index, card] of [file, browser].entries()) {
      Object.assign(card.style, { left: `${160 + index * 720}px`, top: '160px', width: '640px', height: '420px' });
    }
    const boardId = `qa-context-board-${nonce}`, title = `QA context ${nonce}`;
    api.agenda.save({ agendaId: boardId, title, memberIds: [file.id, browser.id], contextBindings: [] });
    return { boardId, title, originalIds: [file.id, browser.id], longUrlViewId: longBrowser.id };
  }, { fileUrl: pathToFileURL(sourceFile).href, nonce });
  const thread = await newQaThread(harness, `QA context ${nonce}`);
  await visible(harness, '.egd-chat-card .egd-chat-card-title');
  await chrome(harness, () => {
    window.__egdeskQaHeaderErrors = [];
    window.__egdeskQaHeaderListener = event => window.__egdeskQaHeaderErrors.push(String(event.message));
    window.addEventListener('error', window.__egdeskQaHeaderListener, true);
  });
  await harness.click('.egd-chat-card .egd-chat-card-title');
  const headerErrors = await chrome(harness, () => {
    window.removeEventListener('error', window.__egdeskQaHeaderListener, true);
    const errors = [...window.__egdeskQaHeaderErrors];
    delete window.__egdeskQaHeaderListener;
    delete window.__egdeskQaHeaderErrors;
    return errors;
  });
  check('native Chat card header click does not raise the missing pan helper error',
    !headerErrors.some(message => message.includes('startPanIfNeeded')));
  const moveToHud = (await harness.inspect('.egd-chat-card button[title="우측 패널로 이동"]'))[0];
  if (moveToHud?.visible) {
    await clickThen('Dock existing Chat in the side panel', '.egd-chat-card button[title="우측 패널로 이동"]',
      () => chrome(harness, () => window.__egdesk.state.codex.chatDockMode), value => value === 'hud');
    await selectQaThread(harness, thread);
  }
  await harness.click('[aria-label="Board 목록"]');
  await harness.fill('.egd-agenda-switch-search-input', scene.title);
  await clickThen('Open the saved QA Board', hook('board-open') + attributeSelector('data-board-id', scene.boardId),
    () => chrome(harness, id => Object.values(window.__egdesk.boards.projections().projections).find(item => item.boardId === id), scene.boardId), Boolean);
  const board = await chrome(harness, id => {
    const p = Object.values(window.__egdesk.boards.projections().projections).find(item => item.boardId === id);
    return { id: p.id, members: p.members.map(item => ({ sourceId: item.sourceId, viewId: item.viewId })) };
  }, scene.boardId);
  const fileView = board.members.find(item => item.sourceId === scene.originalIds[0]).viewId;
  const browserView = board.members.find(item => item.sourceId === scene.originalIds[1]).viewId;
  await clickThen('Open this Board actions menu', hook('board-menu') + attributeSelector('data-projection-id', board.id),
    () => harness.inspect(hook('board-attach-chat') + attributeSelector('data-projection-id', board.id)), nodes => nodes.some(node => node.visible));
  await clickThen('Attach this Board selection to the current Chat', hook('board-attach-chat') + attributeSelector('data-projection-id', board.id), panel, value => value.exists);
  const selected = await chrome(harness, () => [...document.querySelectorAll('[data-testid="chat-attach-source"]')].filter(node => node.checked).map(node => node.dataset.viewId).sort());
  check('Board attach selects only its two actual member views', JSON.stringify(selected) === JSON.stringify([fileView, browserView].sort()));
  const longSelector = hook('chat-attach-source') + attributeSelector('data-view-id', scene.longUrlViewId);
  const longRow = await chrome(harness, selector => {
    const input = document.querySelector(selector), row = input.closest('label'), rect = input.getBoundingClientRect();
    return { locationLength: row.querySelector('small').textContent.length, width: rect.width, height: rect.height,
      rowHeight: row.getBoundingClientRect().height, checked: input.checked };
  }, longSelector);
  result.longUrlRegression = longRow;
  check('20KB source location keeps an actual checkbox-sized control and bounded row', longRow.locationLength > 16000 && longRow.width >= 16 && longRow.height >= 16 && longRow.rowHeight < 200 && !longRow.checked);
  await clickThen('Select long-URL Browser through its actual checkbox', longSelector,
    () => chrome(harness, selector => document.querySelector(selector).checked, longSelector), Boolean);
  await clickThen('Deselect long-URL Browser without changing Board selection', longSelector,
    () => chrome(harness, selector => document.querySelector(selector).checked, longSelector), value => !value);
  await capture('long-url-checkbox-regression');
  await clickThen('Confirm selected attachments', hook('chat-attach-confirm'), roomState, value => value.sources.length === 2);
  let attached = await roomState();
  const fileInput = attached.sources.find(item => item.sourceRef.viewId === fileView);
  const browserInput = attached.sources.find(item => item.sourceRef.viewId === browserView);
  check('file and Browser references preserve their selected view identities', fileInput?.kind === 'file' && fileInput.sourceRef.path === sourceFile && browserInput?.kind === 'browser');
  const chip = id => hook('chat-attachment') + attributeSelector('data-source-id', id);
  await clickThen('Remove one attachment without replacing the other', `${chip(browserInput.id)} ${hook('chat-attachment-remove')}`, roomState, value => value.sources.length === 1);
  await clickThen('Open attachment picker', hook('chat-attach-open'), panel, value => value.exists);
  const choices = await chrome(harness, () => [...document.querySelectorAll('[data-testid="chat-attach-source"]')]
    .map(node => ({ viewId: node.dataset.viewId, checked: node.checked })));
  for (const choice of choices) {
    if (choice.checked !== (choice.viewId === browserView)) {
      await harness.click(hook('chat-attach-source') + attributeSelector('data-view-id', choice.viewId));
    }
  }
  await clickThen('Add the Browser back through its real checkbox', hook('chat-attach-confirm'), roomState, value => value.sources.length === 2);
  check('attachment selection alone creates no capture or send', (await fixtureState()).context.captureBatches === 0 && (await fixtureState()).observed.sends.length === 0);

  await clickThen('Preview the selected local file', `${chip(fileInput.id)} ${hook('chat-attachment-inspect')}`, panel, value => !!value.sourceId);
  const preview = await panel();
  const previewBefore = captureContextReadEvidence(await loopbackJson(`/context/captures/${preview.sourceId}`));
  check('preview labels captured source and does not invent model delivery', preview.sourceLabel && preview.packetId === null && previewBefore.delivered === null);
  check('first page renders the exact first 200 captured lines', preview.sourceText === originalLines.slice(0, 200).join('\n'));
  fs.writeFileSync(sourceFile, changedLines.join('\n'));
  const changedFile = observeQaFixtureFile(harness.profile, sourceFile);
  const batches = (await fixtureState()).context.captureBatches;
  await clickThen('Read the next captured page after changing the live original', hook('chat-input-next'), panel,
    value => value.sourceText === originalLines.slice(200, 400).join('\n'));
  await clickThen('Return to the prior captured page', hook('chat-input-previous'), panel,
    value => value.sourceText === originalLines.slice(0, 200).join('\n'));
  const previewAfter = captureContextReadEvidence(await loopbackJson(`/context/captures/${preview.sourceId}`));
  assertFrozenFileReadAfterMutation({ snapshotBefore: previewBefore, snapshotAfter: previewAfter,
    liveBefore: originalFile, liveAfter: changedFile, expectedSourceText: originalLines.slice(0, 200).join('\n') });
  check('inspector pagination never recaptures the changed live file', (await fixtureState()).context.captureBatches === batches);
  await capture('context-old-source-vs-changed-file');
  await closePanel();

  const draftA = `EGDESK_QA_CONTEXT ${nonce}`, draftB = `QA newer draft ${nonce}; do not send automatically`;
  await control('/__qa/context-config', { failNextCapture: true });
  await sendFromComposer(harness, draftA);
  const failed = await waitUntil(roomState, value => !value.preparing && !!value.error);
  check('failure came from the intentionally configured fixture response, not broken Browser capture', (await fixtureState()).observed.contextCaptureFailures === 1);
  check('capture failure retains exact draft and attachments with zero sends', failed.draft === draftA && failed.sources.length === 2 && (await fixtureState()).observed.sends.length === 0);
  await control('/__qa/context-config', { holdNextCapture: true });
  await sendFromComposer(harness, draftA); // Explicit human retry after definite capture failure.
  await waitUntil(fixtureState, value => value.pendingContextCaptures === 1);
  await harness.fill(hook('chat-composer'), draftB);
  check('newer draft B is present while send A awaits capture', (await roomState()).draft === draftB);
  await control('/__qa/context-release', { phase: 'capture', clientThreadId: thread.wireClientThreadId });
  const accepted = await waitUntil(fixtureState, value => value.observed.sends.length === 1 && value.observed.sends[0].respondedAt);
  const sent = accepted.observed.sends[0], run = accepted.runs.find(item => item.runId === sent.runId);
  result.fixtureIdentity = { conversationId: run.conversationId, runId: run.runId, answerId: run.answerId };
  assertContextSendBindings(sent, { clientThreadId: thread.wireClientThreadId, sourceIds: run.contextCaptures.map(item => item.sourceId) });
  check('delayed A sends once and never clears newer composer B', sent.message === draftA && (await roomState()).draft === draftB);
  const browserCapture = run.contextCaptures.find(item => item.sourceRef.viewId === browserView);
  const browserRead = captureContextReadEvidence(await loopbackJson(`/context/captures/${browserCapture.sourceId}`));
  check('Fission Browser capture contains the exact 610 loaded DOM lines from the selected view',
    browserCapture.sourceRef.url === `http://127.0.0.1:39218/__qa/browser-document/${nonce}`
    && browserCapture.shape.lineCount === 610
    && browserCapture.hash === fingerprintQaBytes(browserText).sha256
    && browserRead.source.text === browserText.split('\n').slice(0, 200).join('\n'));
  const fileCapture = run.contextCaptures.find(item => item.sourceRef.path === sourceFile);
  const inputBefore = captureContextReadEvidence(await loopbackJson(`/context/captures/${fileCapture.sourceId}`));
  check('send-time capture records V1, not the older preview V0', fileCapture.hash === changedFile.sha256 && inputBefore.source.text === changedLines.slice(0, 200).join('\n'));
  fs.writeFileSync(sourceFile, `QA_LIVE_V2_${nonce}\n`);
  const liveV2 = observeQaFixtureFile(harness.profile, sourceFile);
  await control('/__qa/context-release', { runId: run.runId, phase: 'read' });
  const readState = await fixtureState();
  const delivery = readState.context.deliveries.find(item => item.sourceId === fileCapture.sourceId);
  const inputAfter = captureContextReadEvidence(await loopbackJson(`/context/captures/${fileCapture.sourceId}?packetId=${encodeURIComponent(delivery.packet.packetId)}`));
  assertFrozenFileReadAfterMutation({ snapshotBefore: inputBefore, snapshotAfter: inputAfter, liveBefore: changedFile,
    liveAfter: liveV2, expectedSourceText: changedLines.slice(0, 200).join('\n') });
  assertStoredAgentDelivery(inputAfter.delivered, { packetId: delivery.packet.packetId,
    binding: result.fixtureIdentity, expectedToolText: delivery.packet.text });
  check('fixture packet and captured source are distinct and explicitly fixture-only', delivery.fixtureOnly === true && inputAfter.source.text !== inputAfter.delivered.text);

  await clickThen('Open actual input history', hook('chat-activity-open'), () => harness.inspect(hook('chat-input-history')), value => value.length > 0);
  const history = hook('chat-input-history') + attributeSelector('data-run-id', run.runId);
  await harness.click(`${history} summary`);
  await clickThen('Inspect the bound historical input', `${history} ${hook('chat-input-history-open')}${attributeSelector('data-snapshot-id', fileCapture.sourceId)}`,
    panel, value => value.sourceId === fileCapture.sourceId && value.sourceText === changedLines.slice(0, 200).join('\n'));
  await harness.click(`#egd-codex-input-panel ${hook('chat-input-delivery')} > summary`);
  const packetText = await chrome(harness, () => document.querySelector('#egd-codex-input-panel [aria-label="실제로 전달된 payload 원문"]')?.textContent);
  check('history displays the exact stored packet separately from source text', packetText === delivery.packet.text && (await panel()).sourceLabel);
  await capture('context-source-and-exact-fixture-packet');
  await closePanel();
  await clickThen('Close activity panel', '[aria-label="활동 기록 닫기"]', () => harness.inspect(hook('chat-activity-panel')), value => value.length === 0);

  const previousCamera = await camera(harness);
  const evidenceBefore = (await harness.inspect('.egd-input-evidence-card')).length;
  await control('/__qa/context-release', { runId: run.runId, phase: 'briefing' });
  const completed = await waitUntil(fixtureState, value => value.runs.find(item => item.runId === run.runId)?.status === 'completed');
  const briefing = completed.runs.find(item => item.runId === run.runId).briefing;
  assertPublishedBriefing(briefing, { identity: result.fixtureIdentity, captures: run.contextCaptures });
  await visible(harness, hook('briefing-open'));
  check('publishing a Briefing does not auto-open cards or move the camera', (await harness.inspect('.egd-input-evidence-card')).length === evidenceBefore && sameCamera(previousCamera, await camera(harness)));
  const briefingState = () => chrome(harness, () => {
    const session = window.__egdesk.state.codex.briefingSession;
    if (!session) return null;
    const step = session.briefing.steps[session.index];
    const card = [...document.querySelectorAll('.egd-input-evidence-card')].find(node => node._inputReference?.sourceId === step.target.sourceId
      && node._inputReference?.presentationRange?.startLine === step.target.range?.startLine);
    const rect = card?.getBoundingClientRect(), panel = document.getElementById('egd-answer-briefing')?.getBoundingClientRect();
    const points = rect ? [[rect.left + 8, rect.top + 8], [rect.right - 8, rect.top + 8], [rect.left + rect.width / 2, rect.bottom - 8]] : [];
    return { stepId: step.id, preparing: !!session.preparing, loaded: !!card?._inputEvidenceLoaded,
      rect: rect && { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom },
      fits: !!rect && rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= (panel?.top || window.innerHeight)
        && points.every(([x, y]) => card.contains(document.elementFromPoint(x, y))),
      retryButton: !!document.querySelector('[data-testid="briefing-show-evidence"]'),
      focused: document.activeElement?.getAttribute('data-testid') || document.activeElement?.getAttribute('aria-label') || null };
  });
  await clickThen('Open Briefing directly into its first fitted immutable target', hook('briefing-open') + attributeSelector('data-answer-id', run.answerId),
    briefingState, value => value && !value.preparing && value.loaded && value.fits);
  check('first step needs no extra show-evidence or Pan click', !(await briefingState()).retryButton);
  await capture('briefing-first-direct-fit');
  await clickThen('Next step fits its own immutable target directly', hook('briefing-next'), briefingState,
    value => value?.stepId === briefing.steps[1].id && value.loaded && value.fits);
  await capture('briefing-next-direct-fit');
  await clickThen('Previous returns directly to the first target', hook('briefing-previous'), briefingState,
    value => value?.stepId === briefing.steps[0].id && value.loaded && value.fits);
  const comment = `QA step comment ${nonce}`;
  await harness.fill(hook('briefing-comment'), comment);
  await clickThen('Copy this step comment to the existing newer Chat draft', hook('briefing-comment-attach'), roomState,
    value => value.draft.startsWith(draftB) && value.draft.includes(comment));
  const commented = await roomState();
  check('step comment retains immutable dependencies without sending or replacing newer input', commented.briefingInputs.some(item => item.sourceId === briefing.steps[0].target.sourceId)
    && (await fixtureState()).observed.sends.length === 1);
  await clickThen('Exit Briefing back to the previous view', hook('briefing-exit'),
    async () => ({ panel: await harness.inspect(hook('answer-briefing')), camera: await camera(harness) }), value => !value.panel.length && sameCamera(previousCamera, value.camera));
  await capture('briefing-return-and-unsent-step-comment');
  const second = briefing.steps[1].target;
  check('second Briefing step carries the explicit 201–240 restore range', second.range.startLine === 201 && second.range.endLine === 240);
  const rangeText = (await loopbackJson(`/context/captures/${second.sourceId}?startLine=201&endLine=240`)).source.text;
  check('real Briefing navigation materialized that exact evidence range', await chrome(harness, sourceId =>
    [...document.querySelectorAll('.egd-input-evidence-card')].some(card => card._inputReference?.sourceId === sourceId
      && card._inputReference?.presentationRange?.startLine === 201 && card._inputReference?.presentationRange?.endLine === 240), second.sourceId));
  await waitUntil(() => chrome(harness, sourceId => {
    const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
    const saved = JSON.parse(services.prefs.getStringPref('egdesk.deskSession.v1', '{}'));
    return (saved.cards || []).some(card => card.type === 'input-evidence'
      && card.runtimeState?.reference?.sourceId === sourceId
      && card.runtimeState.reference.presentationRange?.startLine === 201
      && card.runtimeState.reference.presentationRange?.endLine === 240);
  }, second.sourceId), Boolean);
  fs.writeFileSync(checkpoint, JSON.stringify({ kind: 'egdesk-context-qa-restart-v1', profile: harness.profile,
    thread, rangeSourceId: second.sourceId, rangeText, fixtureIdentity: result.fixtureIdentity,
    packetSourceId: fileCapture.sourceId, packetSourceText: changedLines.slice(0, 200).join('\n'),
    packetId: delivery.packet.packetId, packetText: delivery.packet.text }), { flag: 'wx', mode: 0o600 });
  result.restartCheck = { phase: 'restored-range', profile: harness.profile,
    instruction: 'Main may restart only this same disposable Firefox, keeping the explicit fixture server. Then run --phase restored-range.' };
  result.pendingLiveAcceptance = 'This script has not proven a native read/Reader/publishBriefing call. Use the separate coordinated Sol/max native stage.';
});
