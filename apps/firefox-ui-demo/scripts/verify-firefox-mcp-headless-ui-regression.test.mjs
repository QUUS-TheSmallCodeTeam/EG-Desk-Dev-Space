import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import {
  VIEWPORTS, assertBeforeDeadline, browserPresentationIssues, canvasComposerClearanceIssues, captureHeadlessScreenshot, chatIssues, firstUseIssues,
  initialFirstUseIssues, observeBrowserPresentation, observeChat, observeSettledFirstUse, observeTargets, parseCli, parseDeadline,
  presentationRestoredOnWiderViewport, projectionGeometrySettled, resizeHeadless,
  sameWorldGeometry, screenshotOutcome, targetIssues, viewportSettled,
  waitFor, waitStableViewport,
  observeChatReachability, chatLoginReachable, chatLastLineReachable, assertChatReachabilityIdentity,
  nextChatReachabilityWheel, chatDocumentEndKey, verifyNarrowChatReachability, NARROW_CHAT_SAMPLE, NARROW_CHAT_WHEEL_LIMIT,
  nextChatLoginWheel,
  observeReachabilityDockPoint, focusChatDockForReachability,
} from './verify-firefox-mcp-headless-ui-regression.mjs';

const roundDeadlineUtc = '2026-10-23T17:00:00Z';
const deadline = Date.parse(roundDeadlineUtc);
const beforeDeadline = deadline - 60_000;

test('native Browser zoom readback checks body plus both rows, exact viewport and every control hit point', () => {
  const before = { cardId: 'egd-browser-card-3', contextId: 16, innerWindowId: 72,
    logicalWidth: 1440, logicalHeight: 573, pageZoom: 1,
    world: { x: 0, y: 0, width: 1440, height: 640 } };
  const after = { ...before, level: 'detail', contentFontPx: 12.5,
    titleFontPx: 11, addressFontPx: 12, controls: [{ width: 32, height: 32, hits: 9 }] };
  assert.deepEqual(browserPresentationIssues(before, after), []);
  for (const key of ['contextId', 'innerWindowId', 'logicalWidth', 'logicalHeight', 'pageZoom']) {
    assert.ok(browserPresentationIssues(before, { ...after, [key]: 999 })
      .includes('browser-identity-viewport-or-world-changed'));
  }
  assert.ok(browserPresentationIssues(before, { ...after, titleFontPx: 8.8 })
    .includes('two-row-bar-font-too-small'));
  assert.ok(browserPresentationIssues(before, { ...after, controls: [{ width: 32, height: 32, hits: 8 }] })
    .includes('two-row-bar-target-unusable'));
  assert.ok(browserPresentationIssues(before, { ...after, controls: [{ width: 24, height: 24, hits: 9 }] })
    .includes('two-row-bar-target-unusable'));
  assert.deepEqual(browserPresentationIssues(before, { ...after, level: 'outline', contentFontPx: 8.5 },
    { expectDetail: false }), []);
});

test('Browser presentation QA emits only local readback, never actor or Agent capture', async () => {
  let emitted;
  const harness = { evaluateChrome: source => { emitted = source; return null; } };
  await observeBrowserPresentation(harness, 'egd-browser-card-3');
  assert.doesNotThrow(() => new vm.Script(`(${emitted})`));
  assert.doesNotMatch(emitted, /toolObserve|agentSnapshot|captureInput|sendQuery|\.ensure\(|\.click\(|setCanvasViewport/);
  assert.match(emitted, /elementFromPoint/);
  assert.match(emitted, /innerWindowId/);
  await assert.rejects(observeBrowserPresentation(harness, '#unowned-selector'), /match/);
});

test('CLI requires an explicit future UTC deadline and a profile; no port or surface override exists', () => {
  assert.equal(parseDeadline(roundDeadlineUtc, beforeDeadline), deadline);
  assert.deepEqual(parseCli(['--profile', '/private/var/tmp/egdesk-chat-test-example',
    '--deadline-utc', roundDeadlineUtc], beforeDeadline), {
    profile: '/private/var/tmp/egdesk-chat-test-example', deadlineMs: deadline,
  });
  const laterNow = Date.parse('2026-11-01T12:00:00Z');
  const laterDeadlineUtc = '2026-11-01T13:00:00Z';
  assert.equal(parseDeadline(laterDeadlineUtc, laterNow), Date.parse(laterDeadlineUtc));
  assert.doesNotThrow(() => assertBeforeDeadline(Date.parse(laterDeadlineUtc), laterNow));
  for (const bad of [undefined, '', '2026-10-23T17:00:00+00:00',
    '2026-02-30T17:00:00Z']) {
    assert.throws(() => parseDeadline(bad, beforeDeadline));
  }
  assert.throws(() => parseDeadline(roundDeadlineUtc, deadline), /deadline/);
  assert.throws(() => assertBeforeDeadline(deadline, deadline), /deadline/);
  assert.throws(() => parseCli(['--profile', '/tmp/a', '--marionettePort', '2828',
    '--deadline-utc', roundDeadlineUtc], beforeDeadline), /usage/);
  assert.throws(() => parseCli(['--profile', '/tmp/a'], beforeDeadline), /required/);
  assert.deepEqual(VIEWPORTS.map(({ width, height }) => `${width}x${height}`),
    ['800x600', '600x600', '960x700', '1280x776']);
});

test('viewport stability rejects requested-but-not-actual resize and unsettled camera', () => {
  const size = { width: 800, height: 600 };
  const stable = { width: 800, height: 600,
    camera: { zoom: 0.8, zoomTarget: 0.8, pan: { x: 10, y: 20 }, panTarget: { x: 10, y: 20 } } };
  assert.equal(viewportSettled(stable, size, stable), true);
  assert.equal(viewportSettled({ ...stable, width: 799 }, size, stable), false);
  assert.equal(viewportSettled({ ...stable, camera: { ...stable.camera, zoom: 0.9 } }, size, stable), false);
  assert.equal(viewportSettled(stable, size, { ...stable,
    camera: { ...stable.camera, pan: { x: 50, y: 20 } } }), false);
});

test('asynchronous viewport proof waits for two real matching samples', async () => {
  const camera = { zoom: 1, zoomTarget: 1, pan: { x: 0, y: 0 }, panTarget: { x: 0, y: 0 } };
  const observed = [{ width: 799, height: 600, camera },
    { width: 800, height: 600, camera }, { width: 800, height: 600, camera }];
  let calls = 0;
  const harness = { evaluateChrome: () => { calls++; return observed.shift(); } };
  const stable = await waitStableViewport(harness, { width: 800, height: 600 }, deadline,
    { now: () => beforeDeadline, pause: async () => {} });
  assert.equal(calls, 3);
  assert.equal(stable.width, 800);
  assert.equal(stable.height, 600);
});

test('a late asynchronous observation cannot satisfy waitFor or trigger another read', async () => {
  let now = beforeDeadline;
  let reads = 0;
  await assert.rejects(waitFor({}, async () => {
    reads++;
    now = deadline;
    return { ready: true };
  }, value => value.ready, deadline, { now: () => now, pause: async () => {} }), /deadline reached/);
  assert.equal(reads, 1);
  now = beforeDeadline;
  await assert.rejects(waitFor({}, async () => {
    now = beforeDeadline + 100;
    return { ready: true };
  }, value => value.ready, deadline,
  { timeoutMs: 100, now: () => now, pause: async () => {} }), /Timed out waiting/);
});

test('headless resize uses only permitted Chrome window resize and reports actual inner size', async () => {
  const window = { innerWidth: 900, innerHeight: 650, outerWidth: 920, outerHeight: 720,
    resizeTo(width, height) { this.innerWidth = width - 20; this.innerHeight = height - 70; } };
  const document = { documentURI: 'chrome://browser/content/browser.xhtml' };
  const Cc = { '@mozilla.org/gfx/info;1': { getService: () => ({ isHeadless: true }) } };
  const harness = { evaluateChrome: source => vm.runInNewContext(source, { window, document, Cc, Ci: {} })() };
  const resized = await resizeHeadless(harness, { width: 800, height: 600 }, deadline,
    () => beforeDeadline);
  assert.deepEqual(JSON.parse(JSON.stringify(resized)), {
    requested: { width: 800, height: 600 }, actual: { width: 800, height: 600 },
  });
  Cc['@mozilla.org/gfx/info;1'].getService = () => ({ isHeadless: false });
  await assert.rejects(resizeHeadless(harness, { width: 960, height: 700 }, deadline,
    () => beforeDeadline), /Refusing resize/);
  assert.equal(window.innerWidth, 800);
  let attempted = false;
  await assert.rejects(resizeHeadless({ evaluateChrome: () => { attempted = true; } },
    { width: 960, height: 700 }, deadline, () => deadline), /deadline reached/);
  assert.equal(attempted, false);
});

test('3x3 hit-point proof rejects a single occluded point, disabled, hidden, and offscreen controls', async () => {
  const node = { isConnected: true, disabled: false, readOnly: false, dataset: { id: 'chat' },
    title: '', id: '', getAttribute: () => null, closest: () => null,
    getBoundingClientRect: () => ({ left: 10, top: 10, right: 110, bottom: 50,
      x: 10, y: 10, width: 100, height: 40 }), contains: hit => hit === node };
  let blocked = false;
  let calls = 0;
  const document = { querySelectorAll: () => [node],
    elementFromPoint() { calls++; return blocked && calls === 1 ? {} : node; } };
  const window = { innerWidth: 800, innerHeight: 600 };
  const getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  const harness = { evaluateChrome: source => vm.runInNewContext(source, { window, document, getComputedStyle })() };
  let [target] = await observeTargets(harness, '#egd-dock .egd-dock-btn');
  assert.equal(calls, 9);
  assert.deepEqual(targetIssues(target), []);
  blocked = true; calls = 0;
  [target] = await observeTargets(harness, '#egd-dock .egd-dock-btn');
  assert.deepEqual(targetIssues(target), ['hit-points-8-of-9']);
  node.disabled = true;
  assert.ok(targetIssues((await observeTargets(harness, 'button'))[0]).includes('disabled-or-readonly'));
  node.disabled = false;
  node.closest = selector => selector.includes('.egd-hud-hidden') ? {} : null;
  assert.ok(targetIssues((await observeTargets(harness, 'button'))[0]).includes('hidden'));
  node.closest = () => null;
  window.innerWidth = 80;
  assert.ok(targetIssues((await observeTargets(harness, 'button'))[0]).includes('outside-viewport'));
});

test('first-use readback requires same browsing context, source URL, world geometry, and real zoom-out', () => {
  const before = { mode: 'desk', initialBrowserFocus: true, fullscreen: true,
    browserCount: 1, cardId: 'browser-1', browserContextId: 123,
    innerWindowId: 456, uri: 'about:blank', sourceUri: 'about:blank',
    logicalWidth: 800, logicalHeight: 600, world: { x: 40, y: 50, width: 800, height: 600 },
    screen: { width: 800, height: 600 }, zoom: 1,
    shellVisible: [false, false, false], separateFirstUse: false };
  const after = { ...before, initialBrowserFocus: false, fullscreen: false,
    shellVisible: [true, true, true], screen: { width: 640, height: 480 }, zoom: 0.7 };
  assert.deepEqual(initialFirstUseIssues(before), []);
  assert.ok(initialFirstUseIssues({ ...before, innerWindowId: null })
    .includes('not-fresh-live-first-use-browser'));
  assert.deepEqual(firstUseIssues(before, after), []);
  assert.ok(firstUseIssues(before, { ...after, browserContextId: 999 })
    .includes('browser-identity-source-or-world-changed'));
  assert.ok(firstUseIssues(before, { ...after, sourceUri: 'about:newtab' })
    .includes('browser-identity-source-or-world-changed'));
  assert.ok(firstUseIssues(before, { ...after, world: { ...after.world, x: 41 } })
    .includes('browser-identity-source-or-world-changed'));
  assert.ok(firstUseIssues(before, { ...after, screen: before.screen })
    .includes('zoomout-geometry-not-observed'));
});

test('first-use postcondition is reread after viewport settlement, never from transition observation', async () => {
  const order = [];
  let stable = false;
  const harness = {};
  const observed = await observeSettledFirstUse(harness, { width: 800, height: 600 }, deadline, {
    settle: async (seenHarness, size, seenDeadline) => {
      assert.equal(seenHarness, harness);
      assert.deepEqual(size, { width: 800, height: 600 });
      assert.equal(seenDeadline, deadline);
      order.push('settle');
      stable = true;
    },
    read: async seenHarness => {
      assert.equal(seenHarness, harness);
      order.push('read');
      return { world: stable ? 'settled-world' : 'transient-world' };
    },
    now: () => beforeDeadline,
  });
  assert.deepEqual(order, ['settle', 'read']);
  assert.equal(observed.world, 'settled-world');
});

test('Chat observation selects only the visible active HUD projection, not a leftover Canvas input', async () => {
  let inputLeft = 100;
  let composerTop = 470;
  let hudOpacity = '1';
  let ancestorOpacity = '1';
  let ancestorVisibility = 'visible';
  const hudAncestor = { parentElement: null };
  const input = { value: 'draft', disabled: false, readOnly: false,
    dataset: { threadId: 'room-1' }, getBoundingClientRect: () => ({ left: inputLeft, top: 100,
      right: inputLeft + 200, bottom: 140, width: 200, height: 40 }),
    contains: hit => hit === input };
  const oldInput = { ...input, value: 'stale hidden input' };
  const composer = { getBoundingClientRect: () => ({ left: 100, top: composerTop,
    right: 320, bottom: composerTop + 40, width: 220, height: 40 }) };
  const zoom = { getBoundingClientRect: () => ({ left: 88, top: 492, right: 250,
    bottom: 533, width: 162, height: 41 }) };
  const hud = { id: 'egd-hud', parentElement: hudAncestor,
    classList: { contains: () => false },
    getBoundingClientRect: () => ({ left: 80, top: 60, right: 360, bottom: 500,
      width: 280, height: 440 }),
    querySelector: selector => selector === '.egd-codex-footer' ? composer : input,
    querySelectorAll: () => [] };
  const oldCard = { ...hud, id: 'egd-chat-card-old', querySelector: () => oldInput };
  const newCard = { ...hud, id: 'egd-chat-card-new',
    style: { left: '147px', top: '76px', width: '440px', height: '680px', maxHeight: '420px' },
    querySelector: selector => selector === '.egd-codex-footer' ? composer : input };
  input.parentElement = hud;
  const state = { codex: { chatDockMode: 'hud', chatCardEntityId: null,
    activeThreadId: 'room-1', threads: [{ id: 'room-1', messages: [] }],
    threadDrafts: { 'room-1': 'draft' }, authStatus: { isLoggedIn: false } },
  hudOpen: true, hudApp: 'chat', zoom: 0.8, zoomTarget: 0.8,
  pan: { x: 0, y: 0 }, panTarget: { x: 0, y: 0 } };
  const window = { innerWidth: 800, innerHeight: 600, __egdesk: { state } };
  let blocked = false;
  let hitCalls = 0;
  const document = { getElementById: id => id === 'egd-hud' ? hud :
    id === 'egd-chat-card-new' ? newCard : id === 'egd-zoom-indicator' ? zoom : oldCard,
  elementFromPoint() { hitCalls++; return blocked && hitCalls === 1 ? {} : input; } };
  const getComputedStyle = node => ({ display: 'block',
    visibility: node === hudAncestor ? ancestorVisibility : 'visible',
    opacity: node === hud ? hudOpacity : node === hudAncestor ? ancestorOpacity : '1' });
  const harness = { evaluateChrome: source => vm.runInNewContext(source, { window, document, getComputedStyle })() };
  const observed = await observeChat(harness);
  assert.equal(observed.rootId, 'egd-hud');
  assert.equal(observed.inputValue, 'draft');
  assert.equal(observed.rootInViewport, true);
  assert.equal(observed.inputInViewport, true);
  assert.equal(observed.inputHitCount, 9);
  assert.deepEqual(chatIssues(observed, { mode: 'hud', threadId: 'room-1', draft: 'draft', messageCount: 0 }), []);
  assert.ok(chatIssues({ ...observed, rootRendered: false, rootEffectiveOpacity: 0 },
    { mode: 'hud', threadId: 'room-1', draft: 'draft', messageCount: 0 })
    .includes('inactive-or-unusable-chat-projection'));
  hudOpacity = '0'; hitCalls = 0;
  const transparentHud = await observeChat(harness);
  assert.equal(transparentHud.rootInViewport, true);
  assert.equal(transparentHud.rootRendered, false);
  assert.equal(transparentHud.rootEffectiveOpacity, 0);
  assert.equal(transparentHud.activeProjection, false);
  assert.equal(hitCalls, 0);
  assert.ok(chatIssues(transparentHud, { mode: 'hud', threadId: 'room-1', draft: 'draft', messageCount: 0 })
    .includes('inactive-or-unusable-chat-projection'));
  hudOpacity = '1'; ancestorOpacity = '0';
  const transparentAncestor = await observeChat(harness);
  assert.equal(transparentAncestor.rootRendered, false);
  assert.equal(transparentAncestor.rootEffectiveOpacity, 0);
  assert.ok(chatIssues(transparentAncestor, { mode: 'hud', threadId: 'room-1', draft: 'draft', messageCount: 0 })
    .includes('inactive-or-unusable-chat-projection'));
  ancestorOpacity = '1'; ancestorVisibility = 'hidden';
  const hiddenAncestor = await observeChat(harness);
  assert.equal(hiddenAncestor.rootRendered, false);
  assert.ok(chatIssues(hiddenAncestor, { mode: 'hud', threadId: 'room-1', draft: 'draft', messageCount: 0 })
    .includes('inactive-or-unusable-chat-projection'));
  ancestorVisibility = 'visible';
  inputLeft = 650;
  const clipped = await observeChat(harness);
  assert.equal(clipped.inputInViewport, false);
  assert.ok(chatIssues(clipped, { mode: 'hud', threadId: 'room-1', draft: 'draft', messageCount: 0 })
    .includes('inactive-or-unusable-chat-projection'));
  inputLeft = 100; blocked = true; hitCalls = 0;
  const occluded = await observeChat(harness);
  assert.equal(occluded.inputHitCount, 8);
  assert.ok(chatIssues(occluded, { mode: 'hud', threadId: 'room-1', draft: 'draft', messageCount: 0 })
    .includes('inactive-or-unusable-chat-projection'));
  blocked = false; hitCalls = 0;
  hud.classList.contains = () => true;
  const hidden = await observeChat(harness);
  assert.equal(hidden.activeProjection, false);
  assert.ok(chatIssues(hidden, { mode: 'hud', threadId: 'room-1', draft: 'draft', messageCount: 0 })
    .includes('inactive-or-unusable-chat-projection'));
  state.codex.chatDockMode = 'canvas';
  state.codex.chatCardEntityId = 'egd-chat-card-new';
  input.parentElement = newCard;
  const returned = await observeChat(harness);
  assert.equal(returned.rootId, 'egd-chat-card-new');
  assert.equal(returned.inputValue, 'draft');
  assert.equal(returned.composerZoomOverlapArea, 18 * 150,
    'actual composer rectangle, not just the 3x3 textarea hit points, exposes the visual overlap');
  assert.ok(canvasComposerClearanceIssues(returned).includes('composer-zoom-overlap'));
  assert.equal(JSON.stringify(returned.world), JSON.stringify({ x: 147, y: 76, width: 440, height: 680 }));
  assert.equal(returned.presentationHeight, 420);
  composerTop = 444;
  const clear = await observeChat(harness);
  assert.equal(clear.composerZoomOverlapArea, 0);
  assert.deepEqual(canvasComposerClearanceIssues(clear), []);
});

test('world-geometry proof rejects missing or changed saved dimensions independent of presentation cap', () => {
  const world = { x: 147, y: 76, width: 440, height: 680 };
  assert.equal(sameWorldGeometry(world, { ...world }), true);
  assert.equal(sameWorldGeometry(world, { ...world, height: 420 }), false);
  assert.equal(sameWorldGeometry(world, { ...world, x: 148 }), false);
  assert.equal(sameWorldGeometry(world, null), false);
  assert.ok(canvasComposerClearanceIssues({ mode: 'canvas', composerRect: null,
    zoomRect: null, composerZoomOverlapArea: null, composerInViewport: false })
    .includes('missing-composer-or-zoom-rect'));
  const narrow = { world, presentationHeight: 421 };
  assert.equal(presentationRestoredOnWiderViewport(narrow, { presentationHeight: 565 }), true);
  assert.equal(presentationRestoredOnWiderViewport(narrow, { presentationHeight: 421 }), false);
  assert.equal(presentationRestoredOnWiderViewport(narrow, { presentationHeight: null }), false);
  assert.equal(presentationRestoredOnWiderViewport({ world, presentationHeight: 680 },
    { presentationHeight: 680 }), true, 'an uncapped user-sized Card remains fully restored');
});

test('HUD projection requires geometry unchanged across the 240ms readiness interval', () => {
  const base = { rootRect: { left: 80, top: 60, right: 360, bottom: 500, width: 280, height: 440 },
    inputRect: { left: 100, top: 100, right: 300, bottom: 140, width: 200, height: 40 } };
  assert.equal(projectionGeometrySettled(null, base), false);
  assert.equal(projectionGeometrySettled(base, base), true);
  assert.equal(projectionGeometrySettled(base, { ...base,
    inputRect: { ...base.inputRect, left: 102, right: 302 } }), false);
});

test('screenshot unsupported is unverified, while other errors remain errors', () => {
  const exact = 'screenshot_page: Error: BiDi error: "unsupported operation"';
  assert.deepEqual(screenshotOutcome(new Error(exact)),
    { status: 'unsupported', visualPass: null, reason: 'MCP BiDi chrome screenshot unsupported' });
  assert.deepEqual(screenshotOutcome('/private/var/tmp/egdesk-chat-evidence-x/headless-800x600.png'),
    { status: 'captured', path: '/private/var/tmp/egdesk-chat-evidence-x/headless-800x600.png', visualPass: null });
  assert.deepEqual(screenshotOutcome(new Error('MCP screenshot_page timed out')),
    { status: 'error', visualPass: null, error: 'MCP screenshot_page timed out' });
  for (const message of ['evaluate_privileged_script: Error: BiDi error: "unsupported operation"',
    'profile check failed: unsupported operation', 'UnsupportedOperationError: unsupported operation',
    'screenshot_page: Error: unrelated failure']) {
    assert.deepEqual(screenshotOutcome(new Error(message)),
      { status: 'error', visualPass: null, error: message });
  }
});

test('headless screenshot caller opts in per call, passes the deadline, and records capture metadata without visual proof', async () => {
  const calls = [];
  const harness = { lastScreenshotMetadata: { route: 'stale', width: 1, height: 1 },
    async screenshot(name, options) {
      calls.push({ name, options });
      this.lastScreenshotMetadata = { route: 'headless-chrome', width: 800, height: 600 };
      return '/private/var/tmp/egdesk-headless-800x600.png';
    } };
  const captured = await captureHeadlessScreenshot(harness, '800x600', deadline, () => beforeDeadline);
  assert.deepEqual(calls, [{ name: 'headless-800x600',
    options: { allowHeadlessChromeFallback: true, deadlineMs: deadline } }]);
  assert.deepEqual(captured, { viewport: '800x600', status: 'captured',
    path: '/private/var/tmp/egdesk-headless-800x600.png', visualPass: null,
    route: 'headless-chrome', width: 800, height: 600 });
  const noMetadata = await captureHeadlessScreenshot({ screenshot: async () => '/tmp/captured.png' },
    '600x600', deadline, () => beforeDeadline);
  assert.deepEqual(noMetadata, { viewport: '600x600', status: 'captured', path: '/tmp/captured.png',
    visualPass: null, route: null, width: null, height: null });
  await assert.rejects(captureHeadlessScreenshot(harness, '800x600', deadline, () => deadline),
    /deadline reached/);
  assert.equal(calls.length, 1, 'expired deadline never starts a second capture');
  let now = beforeDeadline;
  await assert.rejects(captureHeadlessScreenshot({ async screenshot() {
    now = deadline;
    return '/tmp/late.png';
  } }, '800x600', deadline, () => now), /deadline reached/);
});

test('runner contains no provider submit path or synthetic DOM action fallback', () => {
  const source = readFileSync(new URL('./verify-firefox-mcp-headless-ui-regression.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\/chat\/send|newQaThread|sendFromComposer|loopbackJson|\.dispatchEvent\(|\.click\(\)/);
  assert.match(source, /const after = await observeSettledFirstUse\(harness, firstSize, deadlineMs\)/);
  assert.match(source, /deadlineMs, \{ intervalMs: 240 \}\)/);
  assert.match(source, /await scanControls\(harness, size, deadlineMs, result, `\$\{size\.width\}x\$\{size\.height\} HUD-open`\)/);
  assert.match(source, /const hudAfterScan = await observeChat\(harness\)/);
  assert.match(source, /canvasComposerClearanceIssues\(canvasClearance\)/);
  assert.match(source, /resize preserves the same Chat Card and saved world geometry/);
  assert.match(source, /wider viewport restores Chat presentation height/);
  assert.match(source, /fitAll = \{ status: 'click-only', fitPass: null \}/);
  assert.match(source, /result\.screenshots\.push\(await captureHeadlessScreenshot\(harness, stage, deadlineMs\)\)/);
  assert.match(source, /catch \(error\) \{\s*assertBeforeDeadline\(deadlineMs\);\s*const outcome = screenshotOutcome\(error\)/);
  assert.match(source, /if \(outcome\.status === 'error'\) throw error/);
  assert.match(source, /await harness\.click\(selector\)/);
  assert.match(source, /await harness\.fill\(selector, value\)/);
  assert.match(source, /await harness\.press\('meta\+-'\)/);
  assert.match(source, /await harness\?\.close\(\)/);
});

// Pure validator/orchestrator samples, not actual browser outcomes. Only Main's
// native run can establish UI reachability and supply reviewable raster proof.
function reachabilitySample(width = 600) {
  const draft = 'EG-Desk headless QA draft — never send';
  const rect = { left: 100, top: 400, right: 400, bottom: 440, width: 300, height: 40 };
  const box = { shown: true, fullyVisible: true, hitCount: 9, disabled: false, readOnly: false, rect,
    wheelPoint: { x: 200, y: 420 }, scrollTop: 0, scrollHeight: 64, clientHeight: 40 };
  return { mode: 'canvas', rootId: 'chat-1', cardId: 'chat-1', activeEntityId: 'chat-1', threadId: 'thread-1',
    inputThreadId: 'thread-1', messagesThreadId: 'thread-1', conversationId: null, messageCount: 0, isSending: false,
    inputCount: 1, messagesCount: 1,
    sendDisabled: true, loggedIn: false, loginInProgress: false, accountBound: false, draft,
    viewport: { width, height: 600 }, camera: { zoom: 0.96, zoomTarget: 0.96, pan: { x: 100, y: 50 }, panTarget: { x: 100, y: 50 } },
    input: { ...box, value: draft, focused: false, selectionStart: 0, selectionEnd: 0,
      contentHeight: 24, lineHeight: 20, fontPx: 14, projectedFontPx: 13.44 },
    messages: { ...box, scaleY: 1, wheelPoint: { x: 200, y: 180 }, scrollTop: 160, scrollHeight: 360, clientHeight: 200 },
    login: { count: 1, text: '로그인', box: { ...box, fullyVisible: false, hitCount: 6,
      rect: { left: 100, top: 144, right: 160, bottom: 174, width: 60, height: 30 },
      clip: { left: 100, top: 150, right: 400, bottom: 230 } }, missingTextRects: 0,
      textFragments: [{ text: '로그인', rect: { width: 36, height: 20 }, hitCount: 0, inside: false }] } };
}

function unitReachability(width = 600) {
  const state = reachabilitySample(width), calls = [], captures = [];
  const sync = () => {
    const box = state.login.box;
    box.rect.top = 304 - state.messages.scrollTop; box.rect.bottom = box.rect.top + box.rect.height;
    const visible = box.rect.top >= box.clip.top && box.rect.bottom <= box.clip.bottom;
    state.login.box.fullyVisible = visible; state.login.box.hitCount = visible ? 9 : 6;
    state.login.textFragments[0].inside = visible; state.login.textFragments[0].hitCount = visible ? 3 : 0;
  };
  const end = () => {
    state.input.selectionStart = state.input.selectionEnd = state.input.value.length;
    state.input.scrollTop = state.input.scrollHeight - state.input.clientHeight;
  };
  const harness = {
    async wheelAt(input) {
      calls.push({ kind: 'wheel', input }); const box = input.y === 180 ? state.messages : state.input;
      box.scrollTop = Math.max(0, Math.min(box.scrollHeight - box.clientHeight, box.scrollTop + input.deltaY)); sync();
    },
    async clickPoint(input) { calls.push({ kind: 'click', input }); assert.equal(input.y, 420); state.input.focused = true; },
    async press(key) {
      calls.push({ kind: 'key', key }); assert.ok(['meta+ArrowDown', 'Control+End', 'Backspace'].includes(key));
      if (key === 'Backspace') { state.input.value = state.input.value.slice(0, -1); state.draft = state.input.value; }
      end();
    },
    async typeText(text) {
      calls.push({ kind: 'type', text }); assert.equal(text, NARROW_CHAT_SAMPLE);
      state.input.value += text; state.draft = state.input.value; end();
    },
  };
  const options = { now: () => beforeDeadline, pause: async () => {}, platform: 'darwin',
    read: async () => { sync(); return structuredClone(state); },
    capture: async (_harness, label) => { captures.push(label); return { status: 'captured', path: `/unit/${label}.png`, visualPass: null }; } };
  return { state, calls, captures, harness, options, result: { checks: [] } };
}

test('narrow login requires whole control plus every text fragment; input-box hits alone cannot prove its last line', () => {
  const value = reachabilitySample();
  assert.equal(chatLoginReachable(value), false); assert.equal(chatLastLineReachable(value), false);
  value.login.box.fullyVisible = true; value.login.box.hitCount = 9;
  value.login.textFragments[0].inside = true; value.login.textFragments[0].hitCount = 3;
  assert.equal(chatLoginReachable(value), true);
  for (const corrupt of [v => { v.login.count = 2; }, v => { v.login.text = '로그인 중…'; },
    v => { v.login.box.hitCount = 8; }, v => { v.login.box.disabled = true; },
    v => { v.login.missingTextRects = 1; }, v => { v.login.textFragments[0].inside = false; },
    v => { v.login.textFragments[0].hitCount = 2; }, v => { v.login.textFragments = []; }]) {
    const changed = structuredClone(value); corrupt(changed); assert.equal(chatLoginReachable(changed), false);
  }
  value.input.scrollTop = 24; assert.equal(chatLastLineReachable(value), true);
  assert.equal(chatLastLineReachable(value, { caret: true }), false);
  value.input.focused = true; value.input.selectionStart = value.input.selectionEnd = value.input.value.length;
  assert.equal(chatLastLineReachable(value, { caret: true }), true);
  for (const corrupt of [v => { v.input.contentHeight = 19; }, v => { v.input.lineHeight = null; },
    v => { v.input.scrollTop = 20; }, v => { v.input.projectedFontPx = 9; },
    v => { v.input.selectionStart--; }, v => { v.input.hitCount = 8; }, v => { v.input.fullyVisible = false; }]) {
    const changed = structuredClone(value); corrupt(changed); assert.equal(chatLastLineReachable(changed, { caret: true }), false);
  }
});

test('reachability identity rejects draft/room/projection/camera/auth/send mutations without weakening original checks', () => {
  const value = reachabilitySample(); assert.equal(assertChatReachabilityIdentity(value, structuredClone(value)), true);
  for (const corrupt of [v => { v.cardId = 'ghost'; }, v => { v.threadId = 'foreign'; }, v => { v.messagesThreadId = 'foreign'; },
    v => { v.inputThreadId = 'foreign'; }, v => { v.draft += 'x'; }, v => { v.input.value += 'x'; },
    v => { v.inputCount = 2; }, v => { v.messagesCount = 0; },
    v => { v.camera.pan.x++; }, v => { v.camera.zoom = 0.5; }, v => { v.viewport.height++; },
    v => { v.messageCount++; }, v => { v.isSending = true; }, v => { v.sendDisabled = false; },
    v => { v.loggedIn = true; }, v => { v.loginInProgress = true; }, v => { v.accountBound = true; }]) {
    const changed = structuredClone(value); corrupt(changed); assert.throws(() => assertChatReachabilityIdentity(value, changed));
  }
  const append = structuredClone(value); append.draft += NARROW_CHAT_SAMPLE; append.input.value = append.draft;
  assert.equal(assertChatReachabilityIdentity(value, append, append.draft), true, 'only explicitly expected temporary text differs');
});

test('wheel plans use observed owned points, bounded deltas, and never dispatch at exhausted scroll boundaries', () => {
  const value = reachabilitySample();
  assert.deepEqual(nextChatReachabilityWheel(value, 'messages', -1), { x: 200, y: 180, deltaX: 0, deltaY: -80 });
  assert.equal(nextChatReachabilityWheel(value, 'input', -1), null);
  assert.deepEqual(nextChatReachabilityWheel(value, 'input', 1), { x: 200, y: 420, deltaX: 0, deltaY: 24 });
  assert.deepEqual(nextChatLoginWheel(value), { x: 200, y: 180, deltaX: 0, deltaY: -6 }, 'partly hidden button needs a measured small reveal, not blind scrolling to top');
  const below = structuredClone(value); below.messages.scrollTop = 100; below.login.box.rect.top = 220; below.login.box.rect.bottom = 250;
  assert.equal(nextChatLoginWheel(below).deltaY, 20, 'observed target below clip scrolls down');
  const tooTall = structuredClone(value); tooTall.login.box.clip.bottom = 170;
  assert.equal(nextChatLoginWheel(tooTall), null, 'a 30px button cannot be fully revealed in a 20px aperture');
  const obscured = structuredClone(value); obscured.login.box.rect.top = 160; obscured.login.box.rect.bottom = 190;
  assert.equal(nextChatLoginWheel(obscured), null, 'no blind wheel for non-geometric occlusion');
  value.input.wheelPoint = null; assert.throws(() => nextChatReachabilityWheel(value, 'input', 1));
  assert.throws(() => nextChatReachabilityWheel(value, 'login', -1));
  assert.equal(chatDocumentEndKey('darwin'), 'meta+ArrowDown'); assert.equal(chatDocumentEndKey('win32'), 'Control+End');
});

test('600 native sequence records initial clipping, reaches login without click, appends/restores exact suffix and retains raster-review pending', async () => {
  const unit = unitReachability();
  const proof = await verifyNarrowChatReachability(unit.harness, { width: 600, height: 600 }, deadline, unit.result, unit.options);
  assert.equal(proof.verified, true); assert.equal(proof.initialClipping.loginFullyVisible, false);
  assert.equal(proof.initialClipping.lastLineViewportAvailable, false); assert.equal(proof.visualPass, null);
  assert.equal(proof.lastLineRasterReview, 'pending-first-person-review');
  assert.equal(proof.appended.draft, proof.initial.draft + NARROW_CHAT_SAMPLE);
  assert.equal(proof.restored.draft, proof.initial.draft); assert.deepEqual(proof.restored.camera, proof.initial.camera);
  assert.equal(unit.calls.filter(call => call.kind === 'click').length, 1);
  assert.equal(unit.calls.find(call => call.kind === 'click').input.y, 420, 'only composer point clicked, never login');
  assert.equal(unit.calls.filter(call => call.key === 'Backspace').length, NARROW_CHAT_SAMPLE.length);
  assert.equal(unit.calls.filter(call => call.kind === 'type').length, 1);
  assert.ok(unit.captures.includes('600x600-chat-initial-clipping') && unit.captures.includes('600x600-chat-native-sample-appended'));
  assert.ok(unit.result.checks.every(row => row.passed));
});

test('800 sequence proves reachability without changing draft; missing movement or ambiguous wheel fails with one input and evidence', async () => {
  const unit = unitReachability(800);
  const proof = await verifyNarrowChatReachability(unit.harness, { width: 800, height: 600 }, deadline, unit.result, unit.options);
  assert.equal(proof.verified, true); assert.equal(unit.calls.some(call => call.kind === 'type' || call.key === 'Backspace'), false);
  for (const error of [null, new Error('ambiguous native timeout')]) {
    const bad = unitReachability(800); let calls = 0;
    bad.harness.wheelAt = async () => { calls++; if (error) throw error; };
    await assert.rejects(verifyNarrowChatReachability(bad.harness, { width: 800, height: 600 }, deadline, bad.result, bad.options),
      /must move|ambiguous native timeout/);
    assert.equal(calls, 1); assert.equal(bad.result.narrowChatReachability[0].verified, false);
    assert.ok(bad.captures.includes('800x600-chat-reachability-failure'));
    assert.equal(bad.calls.length, 0, 'no subsequent click, key, append or recovery input');
  }
});

test('login unreachable after bounded progress remains a failure, never waived as initial clipping', async () => {
  const unit = unitReachability(800); unit.state.messages.scrollTop = 1000; unit.state.messages.scrollHeight = 1200;
  await assert.rejects(verifyNarrowChatReachability(unit.harness, { width: 800, height: 600 }, deadline, unit.result, unit.options), /login full text/);
  assert.equal(unit.calls.filter(call => call.kind === 'wheel').length, NARROW_CHAT_WHEEL_LIMIT);
  assert.equal(unit.calls.some(call => call.kind === 'click'), false);
});

test('delayed native draft commit is observation-only; an unexpected suffix fails without destructive cleanup', async () => {
  const delayed = unitReachability();
  const type = delayed.harness.typeText;
  let stale = null, remaining = 0;
  delayed.harness.typeText = async text => {
    stale = structuredClone(delayed.state); await type(text); remaining = 2;
  };
  const read = delayed.options.read;
  delayed.options.read = async () => remaining-- > 0 ? structuredClone(stale) : read();
  const proof = await verifyNarrowChatReachability(delayed.harness, { width: 600, height: 600 }, deadline, delayed.result, delayed.options);
  assert.equal(proof.verified, true); assert.equal(delayed.calls.filter(call => call.kind === 'type').length, 1);
  const changed = unitReachability();
  changed.harness.typeText = async () => {
    changed.state.input.value += ' NOT_THE_OWNED_SUFFIX'; changed.state.draft = changed.state.input.value;
  };
  await assert.rejects(verifyNarrowChatReachability(changed.harness, { width: 600, height: 600 }, deadline, changed.result, changed.options));
  assert.equal(changed.calls.some(call => call.key === 'Backspace'), false);
  assert.ok(changed.state.draft.endsWith(' NOT_THE_OWNED_SUFFIX'));
  assert.ok(changed.captures.includes('600x600-chat-reachability-failure'));
});

test('deadline and unexpected camera movement stop bounded reachability without subsequent native input', async () => {
  const expired = unitReachability(); expired.options.now = () => deadline;
  await assert.rejects(verifyNarrowChatReachability(expired.harness, { width: 600, height: 600 }, deadline, expired.result, expired.options), /deadline/);
  assert.equal(expired.calls.length, 0); assert.equal(expired.captures.length, 0);
  const changed = unitReachability(), wheel = changed.harness.wheelAt;
  changed.harness.wheelAt = async input => { await wheel(input); changed.state.camera.pan.x++; };
  await assert.rejects(verifyNarrowChatReachability(changed.harness, { width: 600, height: 600 }, deadline, changed.result, changed.options), /pan\/zoom/);
  assert.equal(changed.calls.length, 1); assert.equal(changed.calls[0].kind, 'wheel');
  assert.ok(changed.captures.includes('600x600-chat-reachability-failure'));
});

test('reachability observer stays bounded/read-only and native implementation preserves original capture/roundtrip assertions', async () => {
  let source;
  await observeChatReachability({ evaluateChrome: value => { source = value; return null; } });
  assert.doesNotThrow(() => new vm.Script(`(${source})`));
  assert.ok(Buffer.byteLength(source) < 14000);
  assert.doesNotMatch(source, /\.focus\(|\.scrollTo\(|\.scrollIntoView\(|\.setSelectionRange\(|\.dispatchEvent\(|\.click\(|\.scrollTop\s*=/);
  assert.match(source, /createRange/); assert.match(source, /data-testid="chat-composer"/);
  assert.match(source, /\.egd-codex-empty-actions button\.egd-codex-chip-primary/);
  const script = readFileSync(new URL('./verify-firefox-mcp-headless-ui-regression.mjs', import.meta.url), 'utf8');
  assert.match(script, /frame\.chat = await chatRoundTrip/);
  assert.match(script, /size\.height === 600 && \[600, 800\]\.includes\(size\.width\)/);
  assert.ok(script.indexOf('result.baselineChecksBeforeReachability = result.checks.length') >
    script.indexOf('result.screenshots.push(await captureHeadlessScreenshot(harness, stage, deadlineMs))'));
  assert.ok(script.indexOf('await verifyNarrowChatReachability(harness, size, deadlineMs, result)') >
    script.indexOf('result.baselineChecksBeforeReachability = result.checks.length'));
  assert.match(script, /await harness\.wheelAt\(input\)/); assert.match(script, /await harness\.clickPoint\(input\)/);
  assert.doesNotMatch(script, /harness\.press\([^\n]*(?:Enter|Return)|startLogin\(|refreshAuthStatus\(|\.focus\(|\.scrollTop\s*=/);
});

function dockPointSample() {
  return { id: 'chat', visible: true, disabled: false, readOnly: false, hitCount: 9, inViewport: true, clipped: false,
    rect: { x: 10, y: 540, width: 32, height: 32 }, point: { x: 26, y: 556 }, pointHit: true, viewport: { width: 600, height: 600 } };
}

test('new Dock entry uses two stable 9-hit observations and one exact integer native point, never UID input', async () => {
  const target = dockPointSample(), order = [], result = { checks: [], actions: [] };
  const harness = { async clickPoint(point) { order.push(['point', point]); },
    async click() { assert.fail('UID path forbidden in new reachability entry'); } };
  const proof = await focusChatDockForReachability(harness, { width: 600, height: 600 }, deadline, result, {
    now: () => beforeDeadline, pause: async ms => { order.push(['pause', ms]); },
    read: async () => { order.push(['observe']); return [structuredClone(target)]; },
  });
  assert.deepEqual(order, [['observe'], ['pause', 120], ['observe'], ['point', target.point]]);
  assert.equal(proof.completed, true); assert.equal(proof.clickCount, 1);
  assert.ok(result.checks.every(row => row.passed));
});

test('moved, occluded, clipped or ambiguous Dock points fail before input; click errors never retry or re-observe to reclick', async () => {
  const target = dockPointSample();
  for (const mutate of [value => { value.rect.x += 0.1; }, value => { value.point.x++; },
    value => { value.hitCount = 8; }, value => { value.pointHit = false; }, value => { value.clipped = true; },
    value => { value.visible = false; }, value => { value.disabled = true; }, value => { value.viewport.width = 800; }]) {
    const changed = structuredClone(target); mutate(changed);
    const samples = [[structuredClone(target)], [changed]], result = { checks: [], actions: [] };
    let clicks = 0, captures = 0;
    await assert.rejects(focusChatDockForReachability({ async clickPoint() { clicks++; } },
      { width: 600, height: 600 }, deadline, result, { now: () => beforeDeadline, pause: async () => {},
        read: async () => samples.shift(), capture: async () => { captures++; return { status: 'captured', path: '/unit/failure.png' }; } }));
    assert.equal(clicks, 0); assert.equal(captures, 1); assert.equal(result.reachabilityDockFocus[0].dispatched, false);
  }
  for (const failure of [new Error('ambiguous native timeout'), new Error('stale/invalid context')]) {
    let reads = 0, clicks = 0, captures = 0; const result = { checks: [], actions: [] };
    await assert.rejects(focusChatDockForReachability({ async clickPoint() { clicks++; throw failure; } },
      { width: 600, height: 600 }, deadline, result, { now: () => beforeDeadline, pause: async () => {},
        read: async () => { reads++; return [structuredClone(target)]; },
        capture: async () => { captures++; return { status: 'captured', path: '/unit/failure.png' }; } }), error => error === failure);
    assert.deepEqual({ reads, clicks, captures }, { reads: 2, clicks: 1, captures: 1 });
    assert.equal(result.reachabilityDockFocus[0].completed, false); assert.equal(result.actions.length, 0);
  }
  await assert.rejects(focusChatDockForReachability({ clickPoint: () => assert.fail('no ambiguous input') },
    { width: 600, height: 600 }, deadline, { checks: [], actions: [] }, { now: () => beforeDeadline,
      read: async () => [target, target], capture: async () => ({ status: 'captured' }) }), /preflight/);
});

test('new Dock observation is read-only, tests the exact integer point, and baseline UID call sites remain separate', async () => {
  let source;
  await observeReachabilityDockPoint({ evaluateChrome: value => { source = value; return null; } });
  assert.doesNotThrow(() => new vm.Script(`(${source})`));
  assert.match(source, /pointHit: owned\(point\.x, point\.y\)/);
  assert.doesNotMatch(source, /\.focus\(|\.click\(|\.scrollTo\(|\.scrollIntoView\(|\.dispatchEvent\(/);
  assert.doesNotMatch(focusChatDockForReachability.toString(), /harness\.click\(|safeClick\(|uidFor|withFreshUid|\.focus\(/);
  const script = readFileSync(new URL('./verify-firefox-mcp-headless-ui-regression.mjs', import.meta.url), 'utf8');
  const newPhase = script.slice(script.indexOf('result.baselineChecksBeforeReachability = result.checks.length'));
  assert.match(newPhase, /await focusChatDockForReachability\(harness, size, deadlineMs, result\)/);
  assert.doesNotMatch(newPhase, /safeClick\(|harness\.click\(/);
  assert.match(script, /await safeClick\(harness, '#egd-dock \.egd-dock-btn\[data-id="chat"\]', 'open\/focus Chat from Dock'/);
});

test('Dock observer detects occlusion at the rounded dispatch pixel even when all nine fractional grid points hit', async () => {
  const r = { x: 10.4, y: 540.4, left: 10.4, top: 540.4, right: 41.4, bottom: 571.4, width: 31, height: 31 };
  const point = { x: 25, y: 555 };
  const node = { isConnected: true, dataset: { id: 'chat' }, disabled: false, readOnly: false, parentElement: null,
    closest: () => null, contains: hit => hit === node, getBoundingClientRect: () => r };
  let obstructPoint = false;
  const document = { querySelectorAll: selector => { assert.equal(selector, '#egd-dock .egd-dock-btn[data-id="chat"]'); return [node]; },
    elementFromPoint: (x, y) => obstructPoint && x === point.x && y === point.y ? {} : node };
  const getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  const harness = { evaluateChrome: source => vm.runInNewContext(source, { document, getComputedStyle, innerWidth: 600, innerHeight: 600 })() };
  const [clear] = await observeReachabilityDockPoint(harness);
  assert.deepEqual(JSON.parse(JSON.stringify(clear.point)), point); assert.equal(clear.hitCount, 9); assert.equal(clear.pointHit, true);
  obstructPoint = true;
  const [occluded] = await observeReachabilityDockPoint(harness);
  assert.equal(occluded.hitCount, 9); assert.equal(occluded.pointHit, false);
});
