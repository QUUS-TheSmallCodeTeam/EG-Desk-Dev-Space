import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import {
  VIEWPORTS, assertBeforeDeadline, canvasComposerClearanceIssues, captureHeadlessScreenshot, chatIssues, firstUseIssues,
  initialFirstUseIssues, observeChat, observeSettledFirstUse, observeTargets, parseCli, parseDeadline,
  presentationRestoredOnWiderViewport, projectionGeometrySettled, resizeHeadless,
  sameWorldGeometry, screenshotOutcome, targetIssues, viewportSettled,
  waitFor, waitStableViewport,
} from './verify-firefox-mcp-headless-ui-regression.mjs';

const roundDeadlineUtc = '2026-10-23T17:00:00Z';
const deadline = Date.parse(roundDeadlineUtc);
const beforeDeadline = deadline - 60_000;

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
