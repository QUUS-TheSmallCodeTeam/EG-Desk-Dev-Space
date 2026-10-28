#!/usr/bin/env node
// Attaches only to a separately launched, marked, synthetic QA profile. The
// caller owns Firefox, the pinned loader, fixture, OS isolation and cleanup.
// Native actions use the existing MCP harness; Chrome evaluation only reads.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertQaFixtureManifest, qaProfileSourceFingerprints } from './egdesk-chat-qa-profile.mjs';
import { assertQaProfileBridge } from './egdesk-qa-fixture-isolation.mjs';
import { inspectLoaderDirectory } from './verify-clean-profile-boot.mjs';
import { FirefoxMcpChatHarness, resolveQaMarionettePort } from './firefox-mcp-chat-harness.mjs';
import { attributeSelector, chrome, selectQaThread } from './egdesk-qa-ui-flow.mjs';
import { assertBeforeDeadline, observeGuard, parseDeadline } from './verify-firefox-mcp-headless-ui-regression.mjs';
import { assertContextQaEnvironment, clickContextControl, contextQaJson, guardContextHarness,
  observeBriefingComments, reachBriefingPanelTarget, readContextBeforeDeadline,
  waitContextBeforeDeadline } from './verify-firefox-mcp-context-briefing.mjs';

const scenarios = ['complete', 'typing', 'pan', 'pan-aba', 'canvas-focus', 'step', 'room', 'account', 'close', 'retry', 'inspector'];
const hook = name => attributeSelector('data-testid', name);
const fields = ['engineId', 'engineProfileId', 'clientThreadId', 'conversationId', 'sourceId', 'startLine', 'endLine'];
const uuid = value => typeof value === 'string' && /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(value);
const hash = value => typeof value === 'string' && /^[\da-f]{64}$/i.test(value);

export function parseBriefingMultiCli(argv, now = Date.now()) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(['--profile', '--deadline-utc', '--scenario'].includes(argv[i]) && !values.has(argv[i])
      && argv[i + 1] && !argv[i + 1].startsWith('--'), 'Unique profile, deadline and scenario values required');
    values.set(argv[i], argv[i + 1]);
  }
  assert.ok(values.size === 3 && path.isAbsolute(values.get('--profile') || ''), 'Explicit absolute QA profile, deadline and scenario required');
  assert.ok(scenarios.includes(values.get('--scenario')), 'Unknown Briefing multi-target scenario');
  return { profile: values.get('--profile'), deadlineMs: parseDeadline(values.get('--deadline-utc'), now), scenario: values.get('--scenario') };
}

export function assertBriefingMultiSeed(seed) {
  assert.ok(seed?.version === 1 && seed.setupOnly === true && seed.synthetic === true && seed.ready === true
    && seed.scenario === 'briefing-multi-target', 'Explicit synthetic multi-target seed required');
  assert.ok(seed.account?.key?.startsWith('codex:') && seed.identities?.length === 2);
  const [a, b] = seed.identities, [sourceA, sourceB] = a.sources || [];
  assert.equal(a.sources?.length, 2); assert.equal(b.sources?.length, 1);
  assert.notEqual(a.clientThreadId, b.clientThreadId); assert.notEqual(a.conversationId, b.conversationId);
  assert.equal(a.engineId, 'codex'); assert.equal(a.engineProfileId, 'codex-default');
  assert.ok(a.clientThreadId && a.conversationId && a.answerId && uuid(a.briefing?.id));
  assert.ok(sourceA.kind === 'file' && sourceB.kind === 'file' && sourceA.sourceId !== sourceB.sourceId);
  for (const source of [sourceA, sourceB]) assert.ok(uuid(source.sourceId) && source.snapshotId === source.sourceId && hash(source.captureHash));
  assert.equal(a.briefing.steps.length, 2);
  assert.deepEqual(a.briefing.steps.map(step => step.sourceIds), [[sourceA.sourceId, sourceA.sourceId, sourceB.sourceId], [sourceA.sourceId]]);
  assert.notEqual(a.briefing.steps[0].id, a.briefing.steps[1].id);
  assert.ok(a.preservation?.draftText && b.preservation?.draftText && Array.isArray(a.preservation.briefingInputs));
  assert.deepEqual(seed.counts?.runtimeAtSetup, { captureBatches: 0, fileCaptureOperations: 0, sends: 0, deliveries: 0 });
  return seed;
}

export function expectedBriefingCards(room, count = 3) {
  const [a, b] = room.sources;
  return [
    { sourceId: a.sourceId, hash: a.captureHash, range: { startLine: 1, endLine: 4 }, loaded: true },
    { sourceId: a.sourceId, hash: a.captureHash, range: { startLine: 5, endLine: 8 }, loaded: true },
    { sourceId: b.sourceId, hash: b.captureHash, range: { startLine: 1, endLine: 4 }, loaded: true },
  ].slice(0, count);
}

export function assertBriefingCards(value, room, count = 3) {
  const cards = value.cards.map(({ sourceId, hash, range, loaded }) => ({ sourceId, hash, range, loaded }));
  assert.deepEqual(cards, expectedBriefingCards(room, count), 'Cards must be exact source/hash/range identities, without merged or duplicate targets');
  for (const [i, card] of value.cards.entries()) {
    const prefix = i === 2 ? 'Briefing synthetic B original line ' : 'CTX04 synthetic file original line ';
    const start = i === 1 ? 5 : 1;
    const expected = Array.from({ length: 4 }, (_, offset) => `${prefix}${start + offset}`).join('\n');
    assert.equal(card.text, expected, 'Evidence must render exactly the requested immutable captured lines, never the live file');
  }
  return cards;
}

export function assertHeldCaptureReceipt(receipt, holdId, scope, now = Date.now()) {
  assert.ok(uuid(holdId) && receipt?.holdId === holdId && receipt.kind === 'capture-get' && uuid(receipt.requestId));
  assert.ok(receipt.receivedAt && receipt.receivedAt <= now && receipt.deadlineAt > now && hash(receipt.snapshotHash));
  assert.equal(receipt.account, 'a'); assert.equal(receipt.epoch, 0);
  assert.deepEqual(receipt.R, Object.fromEntries(fields.map(key => [key, scope[key]])));
  assert.equal(receipt.terminalCause, null); assert.equal(receipt.writeAttempted, false);
  return receipt;
}

export function assertNoBriefingEffects(initial, current) {
  assert.deepEqual(current.briefingMultiTargetAttempts, { sendPosts: 0, capturePosts: 0, commentPosts: 0 },
    'Even rejected automatic send, capture or comment-save attempts are forbidden');
  assert.equal(current.observed.sends.length, 0); assert.equal(current.context.captureBatches, 0);
  assert.equal(current.context.fileCaptureOperations, 0); assert.equal(current.context.deliveries.length, 0);
  assert.equal(current.briefingComments.receipts.filter(row => row.method === 'POST' && row.receivedAt !== null).length, 0);
  // The read-only inspection supplies a fresh observation timestamp on each
  // query; compare its stored records, not that changing read clock.
  const { readAt: ignoredBefore, ...before } = initial.briefingComments.storeInspection;
  const { readAt: ignoredAfter, ...after } = current.briefingComments.storeInspection;
  assert.deepEqual(after, before);
}

export function assertPreservedIntent(before, after) {
  assert.deepEqual(after.camera.target, before.camera.target, 'Late completion must not fit over the user camera');
  assert.equal(after.activeEntityId, before.activeEntityId); assert.equal(after.selectionRevision, before.selectionRevision);
  assert.deepEqual(after.focus, before.focus, 'Late completion must not change newer input focus, text or selection');
  assert.equal(after.draft, before.draft); assert.deepEqual(after.attachments, before.attachments); assert.equal(after.stepId, before.stepId);
}

export async function observeBriefingMulti(harness) {
  return chrome(harness, () => {
    const state = window.__egdesk.state, codex = state.codex, session = codex.briefingSession;
    const panel = document.getElementById('egd-answer-briefing'), active = document.activeElement;
    const cards = [...document.querySelectorAll('.egd-input-evidence-card')].map(card => ({
      id: card.id, sourceId: card._inputReference?.sourceId, hash: card._inputReference?.hash,
      range: card._inputReference?.presentationRange || null, loaded: !!card._inputEvidenceLoaded,
      text: card.querySelector('pre[aria-label="당시 캡처 본문"]')?.textContent || null,
    }));
    let styleModes = [];
    try {
      const inspector = globalThis.InspectorUtils || window.InspectorUtils;
      styleModes = [...new Set(Array.from(inspector.getMatchingCSSRules(panel || document.querySelector('.egd-dock-btn'), null))
        .filter(rule => rule.parentStyleSheet?.href?.includes('eg-desk-surface.uc.css'))
        .map(rule => rule.parentStyleSheet.parsingMode))].sort();
    } catch {}
    let wheelPoint = null;
    for (const x of [20, 60, 120, 220, innerWidth - 80]) for (const y of [100, 180, 300, innerHeight - 100]) {
      if (wheelPoint || x < 3 || y < 3 || x >= innerWidth - 3 || y >= innerHeight - 3) continue;
      const hits = [-2, 0, 2].flatMap(dx => [-2, 0, 2].map(dy => document.elementFromPoint(x + dx, y + dy)));
      if (hits.every(node => node && !node.closest('#egd-hud, #egd-codex-activity-panel, #egd-codex-input-panel, #egd-answer-briefing, #egd-zoom-indicator, #egd-dock, #egd-preset-bag, #egd-desk-rail, #egd-desk-minimap, .egd-canvas-card'))) wheelPoint = { x, y };
    }
    return { observedAt: Date.now(), activeThreadId: codex.activeThreadId, accountEmail: codex.authStatus?.accountEmail || null,
      presentationId: session?.presentationId || null,
      stepId: panel?.dataset.stepId || null, preparing: !!session?.preparing, inspector: !!document.getElementById('egd-codex-input-panel'),
      camera: { target: { pan: { ...state.panTarget }, zoom: state.zoomTarget },
        settled: state.zoom === state.zoomTarget && state.pan.x === state.panTarget.x && state.pan.y === state.panTarget.y },
      cameraRevision: state.canvasUserCameraRevision || 0, activeEntityId: state.activeEntityId,
      selectionRevision: state.canvasSelectionRevision || 0, interactionRevision: session?.interaction?.revision || 0,
      focus: { tag: active?.localName || null, id: active?.id || null, testId: active?.dataset?.testid || null,
        cardId: active?.closest?.('.egd-canvas-card')?.id || null,
        value: typeof active?.value === 'string' ? active.value : null,
        start: typeof active?.selectionStart === 'number' ? active.selectionStart : null,
        end: typeof active?.selectionEnd === 'number' ? active.selectionEnd : null },
      comment: panel?.querySelector('[data-testid="briefing-comment"]')?.value || '',
      draft: codex.threadDrafts?.[codex.activeThreadId] || '',
      attachments: codex.threads.map(thread => ({ id: thread.id, inputSources: thread.inputSources || [],
        briefingInputs: thread.briefingInputs || [], briefingCommentRefs: thread.briefingCommentRefs || [] })),
      notice: document.getElementById('egd-board-notice')?.textContent || null,
      statuses: [...(panel?.querySelectorAll('[role="status"]') || [])].map(node => node.textContent),
      retries: [...(panel?.querySelectorAll('[data-testid="briefing-show-evidence"]') || [])].map(node => node.dataset.sourceId),
      cards, styleModes, wheelPoint };
  });
}

export async function verifyBriefingMultiTarget({ harness, deadlineMs, initial, request, check },
  { observe = observeBriefingMulti, select = selectQaThread, click = clickContextControl } = {}) {
  const seed = assertBriefingMultiSeed(initial.briefingCommentsSeed), [a, b] = seed.identities, [sourceA, sourceB] = a.sources;
  const rooms = seed.identities.map(room => room.clientThreadId), budget = { total: 0 };
  const scope = (source, startLine, endLine) => ({ engineId: a.engineId, engineProfileId: a.engineProfileId,
    clientThreadId: a.clientThreadId, conversationId: a.conversationId, sourceId: source.sourceId, startLine, endLine });
  const state = () => request('/__qa/state');
  const read = () => observe(harness);
  const wait = (accept, label, timeoutMs = 15000) => waitContextBeforeDeadline(read, accept, deadlineMs, { label, timeoutMs, intervalMs: 100 });
  const expected = { owner: seed.account.key, route: { engineId: a.engineId, engineProfileId: a.engineProfileId,
    clientThreadId: a.clientThreadId, conversationId: a.conversationId, briefingId: a.briefing.id }, stepId: a.briefing.steps[0].id };
  const panelControl = async selector => {
    await reachBriefingPanelTarget({ selector, deadlineMs, budget, expected,
      read: () => observeBriefingComments(harness, rooms, selector), wheel: input => harness.wheelAt(input),
      accept: value => value.access?.full && value.access.hits === 9 && !value.access.disabled,
      beforeWheel: state, afterWheel: async before => { const after = await state(); assertNoBriefingEffects(initial, after);
        assert.equal(after.observed.sends.length, before.observed.sends.length); return { noNewWrites: true }; } });
    await click(harness, selector, deadlineMs);
  };
  const open = () => click(harness, hook('briefing-open') + attributeSelector('data-answer-id', a.answerId), deadlineMs);
  const arm = async (target, mode = 'hold') => {
    assertBeforeDeadline(deadlineMs);
    const deadlineAt = Math.min(deadlineMs - 1000, Date.now() + 29000);
    assert.ok(deadlineAt > Date.now() + 5000, 'Insufficient remaining time for an owned bounded hold');
    const result = await request('/__qa/context-config', { method: 'POST', body: { captureGetResponse: { ...target, mode, deadlineAt } } });
    assert.ok(uuid(result.holdId) && result.requestId === null); return result.holdId;
  };
  const received = async (holdId, target) => {
    const current = await waitContextBeforeDeadline(state, value => value.captureGet?.receipts.some(row => row.holdId === holdId && row.requestId && hash(row.snapshotHash)),
      deadlineMs, { label: 'exact-capture-received', timeoutMs: 15000, intervalMs: 80 });
    return assertHeldCaptureReceipt(current.captureGet.receipts.find(row => row.holdId === holdId), holdId, target);
  };
  const release = async (target, receipt, allowClosed = false) => {
    const result = await request('/__qa/context-release', { method: 'POST', includeHttpStatus: true,
      body: { phase: 'capture-get', ...target, requestId: receipt.requestId } });
    assert.ok(result.httpStatus === 200 || allowClosed && result.httpStatus === 409, 'Only exact received response can be released');
    const final = await waitContextBeforeDeadline(state, value => value.captureGet.receipts.some(row => row.holdId === receipt.holdId && row.terminalCause),
      deadlineMs, { label: 'capture-terminal', timeoutMs: 5000, intervalMs: 80 });
    const terminal = final.captureGet.receipts.find(row => row.holdId === receipt.holdId);
    assert.equal(terminal.requestId, receipt.requestId); assert.equal(terminal.snapshotHash, receipt.snapshotHash);
    if (result.httpStatus === 200) assert.ok(terminal.writeAttempted && terminal.finishAt && terminal.terminalCause === 'finished');
    else assert.ok(terminal.terminalCause === 'peer-close-before-finish' && !terminal.writeAttempted);
    return result.httpStatus === 200 ? 'server-finished' : 'peer-closed';
  };
  const typeComment = async text => {
    await panelControl(hook('briefing-comment')); await harness.typeText(text);
    return wait(value => value.comment === text && value.focus.testId === 'briefing-comment', 'native-comment-typed');
  };
  const exact = (value, count = 3) => { assertBriefingCards(value, a, count); };
  const settled = () => wait(value => value.presentationId && !value.preparing && value.cards.length === 3 && value.camera.settled, 'all-three-cards');
  const targetSecond = scope(sourceA, 5, 8), targetB = scope(sourceB, 1, 4), targetFirst = scope(sourceA, 1, 4);
  await select(harness, { id: a.clientThreadId, title: a.title, wireClientThreadId: a.clientThreadId });
  const before = await read(); assert.equal(before.activeThreadId, a.clientThreadId); assert.equal(before.draft, a.preservation.draftText);
  let holdId, receipt;
  if (['typing', 'pan', 'pan-aba', 'canvas-focus', 'step', 'room', 'account', 'close'].includes(initial.scenario)) holdId = await arm(targetSecond);
  if (initial.scenario === 'retry') await arm(targetB, 'deny');
  await open();
  if (holdId) {
    receipt = await received(holdId, targetSecond);
    const partial = await wait(value => value.preparing && value.cards.length === 1, 'second-capture-held');
    exact(partial, 1);
    assert.equal(partial.activeEntityId, before.activeEntityId); assert.equal(partial.selectionRevision, before.selectionRevision);
    assert.deepEqual(partial.camera.target, before.camera.target);
    check('actual second immutable GET held after background first card without hidden activation', true);
  }
  if (initial.scenario === 'complete') {
    const complete = await settled(); exact(complete);
    check('three exact immutable cards rendered and normal preparation fitted first card', complete.activeEntityId === complete.cards[0].id
      && JSON.stringify(complete.camera.target) !== JSON.stringify(before.camera.target));
    const recorded = await state();
    assert.deepEqual(recorded.context.inspectorReads.map(({ sourceId, startLine, endLine }) => ({ sourceId, startLine, endLine })),
      [targetFirst, targetSecond, targetB].map(({ sourceId, startLine, endLine }) => ({ sourceId, startLine, endLine })));
    await click(harness, hook('briefing-next'), deadlineMs);
    const next = await wait(value => value.stepId === a.briefing.steps[1].id && value.camera.settled, 'legacy-next-step');
    assert.equal(next.cards.length, 3); assert.equal((await state()).context.inspectorReads.length, 3);
    check('legacy next-step duplicate reused the existing card without another GET', true);
  } else if (initial.scenario === 'typing') {
    const typing = await typeComment('QA unsent during prepare');
    const terminal = await release(targetSecond, receipt), complete = await settled(); exact(complete); assertPreservedIntent(typing, complete);
    check(`preparation preserved typed comment, focus, caret, selection and camera (${terminal})`, true);
  } else if (['pan', 'pan-aba'].includes(initial.scenario)) {
    const current = await read(); assert.ok(current.wheelPoint, 'No safe canvas wheel point');
    await harness.wheelAt({ ...current.wheelPoint, deltaX: 0, deltaY: 130 });
    let panned = await wait(value => value.cameraRevision > current.cameraRevision && value.camera.settled, 'native-pan');
    if (initial.scenario === 'pan-aba') {
      assert.ok(panned.wheelPoint, 'No safe reverse canvas wheel point');
      await harness.wheelAt({ ...panned.wheelPoint, deltaX: 0, deltaY: -130 });
      panned = await wait(value => value.cameraRevision > panned.cameraRevision && value.camera.settled, 'native-pan-return');
      assert.deepEqual(panned.camera.target, current.camera.target, 'Native reverse wheel must return the exact initial camera');
    }
    const terminal = await release(targetSecond, receipt), complete = await settled(); exact(complete); assertPreservedIntent(panned, complete);
    check(`native camera ${initial.scenario === 'pan-aba' ? 'A→B→A' : 'movement'} survived delayed preparation (${terminal})`, true);
  } else if (initial.scenario === 'canvas-focus') {
    let focused = await read();
    for (let i = 0; i < 48 && focused.focus.testId !== 'chat-composer'; i++) {
      await harness.press('Tab'); focused = await read();
    }
    assert.equal(focused.focus.testId, 'chat-composer', 'Native Tab must reach the existing Chat composer');
    assert.equal(focused.focus.cardId, focused.activeEntityId, 'The focused input must be inside the already active Canvas card');
    assert.equal(focused.activeEntityId, before.activeEntityId); assert.equal(focused.selectionRevision, before.selectionRevision);
    assert.equal(focused.draft, before.draft);
    const terminal = await release(targetSecond, receipt), complete = await settled(); exact(complete); assertPreservedIntent(focused, complete);
    check(`native Tab focus on already active Canvas input survived preparation (${terminal})`, true);
  } else if (initial.scenario === 'step') {
    await click(harness, hook('briefing-next'), deadlineMs);
    const next = await wait(value => value.stepId === a.briefing.steps[1].id && value.camera.settled, 'next-step-while-held');
    const terminal = await release(targetSecond, receipt), complete = await settled(); exact(complete); assertPreservedIntent(next, complete);
    check(`step selected during preparation did not bounce on completion (${terminal})`, true);
  } else if (initial.scenario === 'room') {
    await typeComment('QA room-switch draft');
    await select(harness, { id: b.clientThreadId, title: b.title, wireClientThreadId: b.clientThreadId });
    const other = await wait(value => value.activeThreadId === b.clientThreadId && !value.presentationId, 'switch-room-b');
    assert.equal(other.draft, b.preservation.draftText);
    await select(harness, { id: a.clientThreadId, title: a.title, wireClientThreadId: a.clientThreadId });
    const returned = await wait(value => value.activeThreadId === a.clientThreadId && !value.presentationId && value.camera.settled, 'return-room-a');
    const terminal = await release(targetSecond, receipt, true);
    const later = await wait(value => value.observedAt >= returned.observedAt + 500 && value.camera.settled, 'after-old-room-response');
    assert.equal(later.presentationId, null); assert.equal(later.cards.length, returned.cards.length);
    assert.deepEqual(later.camera.target, returned.camera.target); assert.equal(later.draft, a.preservation.draftText);
    await open(); const reopened = await settled(); exact(reopened); assert.equal(reopened.comment, 'QA room-switch draft');
    assert.deepEqual(reopened.attachments, before.attachments);
    check(`A→B→A rejects old preparation and explicit reopen retains comment (${terminal})`, true);
  } else if (initial.scenario === 'account') {
    const change = variant => request('/__qa/account-change', { method: 'POST', body: { variant } });
    await change('b');
    const other = await wait(value => value.accountEmail === 'qa-account-b@egdesk.invalid' && !value.presentationId && value.camera.settled, 'account-b');
    const afterB = await state(), ended = afterB.captureGet.receipts.find(row => row.holdId === receipt.holdId);
    assert.equal(ended?.terminalCause, 'account-change'); assert.equal(ended.responseStatus, 403); assert.equal(ended.requestId, receipt.requestId);
    assert.equal(other.notice, null, 'Canceled read must not show a late error in the new account');
    await change('a');
    const returned = await wait(value => value.accountEmail === 'qa-account-a@egdesk.invalid' && !value.presentationId && value.camera.settled, 'account-a-return');
    const attempt = await request('/__qa/context-release', { method: 'POST', includeHttpStatus: true,
      body: { phase: 'capture-get', ...targetSecond, requestId: receipt.requestId } });
    assert.equal(attempt.httpStatus, 403, 'Account ABA cannot release a previous epoch');
    const later = await wait(value => value.observedAt >= returned.observedAt + 500 && value.camera.settled, 'after-account-aba');
    assert.equal(later.presentationId, null); assert.equal(later.cards.length, returned.cards.length); assert.equal(later.notice, null);
    assert.deepEqual(later.camera.target, returned.camera.target);
    check('synthetic account A→B→A cancels the old epoch without late evidence, notice or camera', true);
  } else if (initial.scenario === 'close') {
    await click(harness, hook('briefing-exit'), deadlineMs);
    const closed = await wait(value => !value.presentationId && value.camera.settled, 'explicit-briefing-close');
    const terminal = await release(targetSecond, receipt, true);
    const later = await wait(value => value.observedAt >= closed.observedAt + 500 && value.camera.settled, 'after-briefing-close');
    assert.equal(later.presentationId, null); assert.equal(later.cards.length, closed.cards.length); assert.equal(later.notice, closed.notice);
    assert.deepEqual(later.camera.target, closed.camera.target); assert.deepEqual(later.focus, closed.focus); assert.equal(later.draft, closed.draft);
    check(`explicit close blocks old evidence, notice and camera (${terminal})`, true);
  } else if (initial.scenario === 'retry') {
    const partial = await wait(value => value.presentationId && !value.preparing && value.cards.length === 2 && value.camera.settled, 'partial-denial');
    exact(partial, 2); assert.ok(partial.retries.includes(sourceB.sourceId));
    assert.ok(partial.statuses.some(text => text.includes('당시 입력을 기록에서 확인하거나 Canvas 근거로 열 수 있습니다.')),
      'Partial failure must remain visibly incomplete');
    assert.ok(partial.notice?.includes('Explicit fixture capture permission denial'), 'Expected denial must be visible');
    await click(harness, '#egd-board-notice button', deadlineMs);
    await wait(value => !value.notice, 'explicitly-dismiss-expected-denial');
    const retryHold = await arm(targetB), selector = hook('briefing-show-evidence') + attributeSelector('data-source-id', sourceB.sourceId);
    await panelControl(selector); const retryReceipt = await received(retryHold, targetB);
    const typing = await typeComment('QA unsent during retry');
    const terminal = await release(targetB, retryReceipt), complete = await settled(); exact(complete); assertPreservedIntent(typing, complete);
    check(`partial denial retained A; delayed explicit retry preserved newer typing (${terminal})`, true);
  } else if (initial.scenario === 'inspector') {
    const complete = await settled(); exact(complete);
    const inspect = '#egd-answer-briefing > ' + hook('briefing-inspect') + attributeSelector('data-source-id', sourceA.sourceId) + ':first-of-type';
    await panelControl(inspect); await wait(value => value.inspector, 'normal-inspector-opens');
    await click(harness, '#egd-codex-input-panel header button', deadlineMs); await wait(value => !value.inspector, 'normal-inspector-close');
    const inspectHold = await arm(targetFirst); await panelControl(inspect); const inspectReceipt = await received(inspectHold, targetFirst);
    const typing = await typeComment('QA newer inspector input');
    const terminal = await release(targetFirst, inspectReceipt);
    const after = await wait(value => value.observedAt >= typing.observedAt + 600 && value.camera.settled, 'after-inspector-response');
    assert.equal(after.inspector, false, 'Late inspector cannot cover newer input'); assertPreservedIntent(typing, after);
    check(`normal inspector opened; delayed inspector did not steal newer input (${terminal})`, true);
  } else throw new Error('Unexpected scenario');
  const final = await state(); assertNoBriefingEffects(initial, final);
  const finalView = await read();
  check('pinned production stylesheet is present in both user and author origins', finalView.styleModes.includes('user') && finalView.styleModes.includes('author'));
  check('no runtime capture, provider send, delivery, or comment save', true);
}

export async function runBriefingMultiTarget(options, { env = process.env,
  createHarness = value => new FirefoxMcpChatHarness(value), scenario = verifyBriefingMultiTarget } = {}) {
  const deadlineMs = Math.min(options.deadlineMs, Date.now() + 180000), profile = options.profile;
  assertContextQaEnvironment(env); assertBeforeDeadline(deadlineMs);
  assert.equal(env.EGDESK_QA_BRIEFING_COMMENTS_SEED, '1'); assert.equal(env.EGDESK_QA_BRIEFING_MULTI_TARGET, '1');
  assert.notEqual(env.EGDESK_QA_CONTEXT_SOURCE_CHANGE_SEED, '1');
  assert.ok(scenarios.includes(options.scenario)); assertQaFixtureManifest(profile);
  const isolation = assertQaProfileBridge(profile, env);
  assert.ok(inspectLoaderDirectory(path.join(profile, 'chrome', 'utils')).matchesPin, 'Pinned user+author loader required');
  const result = { kind: 'briefing-multi-target-fixture-native', scenario: options.scenario, automatedAssertionsPassed: false,
    nativeInputs: true, domInjection: false, providerTurn: 'fixture-only-no-native-provider', checks: [], fixtureIsolation: isolation,
    profileSources: qaProfileSourceFingerprints(profile) };
  let harness;
  try {
    harness = guardContextHarness(createHarness({ profile, marionettePort: resolveQaMarionettePort(env.EGDESK_MARIONETTE_PORT) }), deadlineMs);
    await readContextBeforeDeadline(() => harness.connect(), deadlineMs, { timeoutMs: 10000 });
    const guard = await observeGuard(harness);
    assert.ok(guard.headless && guard.mounted && guard.documentURI === 'chrome://browser/content/browser.xhtml');
    const request = (route, requestOptions) => contextQaJson(route, deadlineMs, { ...requestOptions, env });
    const initial = await request('/__qa/state'); assert.ok(initial.fixture && initial.profile === profile); initial.scenario = options.scenario;
    await scenario({ harness, deadlineMs, initial, request, check(label, passed) { result.checks.push({ label, passed: !!passed }); assert.ok(passed, label); } });
    assertBeforeDeadline(deadlineMs); result.automatedAssertionsPassed = true;
  } catch (error) { result.error = String(error?.stack || error).slice(0, 3000); }
  finally { try { await harness?.close(); } catch (error) { result.cleanupError = String(error.message); result.automatedAssertionsPassed = false; } }
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await runBriefingMultiTarget(parseBriefingMultiCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`); if (!result.automatedAssertionsPassed) process.exitCode = 1;
  } catch (error) { process.stderr.write(`${String(error.message).slice(0, 500)}\n`); process.exitCode = 1; }
}
