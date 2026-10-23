#!/usr/bin/env node
// Attach-only, model-free QA for Main's already-running headless Firefox.
// UI input uses FirefoxMcpChatHarness native MCP tools; Chrome evaluation only
// observes state, except for the explicitly bounded headless window resize.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { FirefoxMcpChatHarness } from './firefox-mcp-chat-harness.mjs';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { chrome } from './egdesk-qa-ui-flow.mjs';

export const VIEWPORTS = Object.freeze([
  { width: 800, height: 600 },
  { width: 600, height: 600 },
  { width: 960, height: 700 },
  { width: 1280, height: 776 },
]);
const DOCK_IDS = Object.freeze(['chat', 'shelf', 'ontology', 'browser', 'ide', 'terminal', 'settings',
  'create', 'pencil', 'hand', 'square', 'ellipse', 'line', 'arrow', 'trash']);
const ZOOM_LABELS = Object.freeze(['Canvas 축소', 'Canvas 확대', '열린 창 전체 보기']);
const DRAFT = 'EG-Desk headless QA draft — never send';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseDeadline(value, now = Date.now()) {
  assert.match(value || '', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/,
    '--deadline-utc must be an explicit whole-second UTC timestamp');
  const deadline = Date.parse(value);
  assert.equal(new Date(deadline).toISOString(), value.replace('Z', '.000Z'), 'invalid UTC deadline');
  assert.ok(now < deadline, 'deadline must be in the future');
  return deadline;
}

export function parseCli(argv, now = Date.now()) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    assert.ok(['--profile', '--deadline-utc'].includes(key) && !values.has(key) && argv[i + 1],
      'usage: --profile CANONICAL_TEMP_QA_PROFILE --deadline-utc UTC_TIMESTAMP');
    values.set(key, argv[i + 1]);
  }
  assert.ok(values.has('--profile') && values.has('--deadline-utc'),
    '--profile and --deadline-utc are both required');
  return { profile: values.get('--profile'), deadlineMs: parseDeadline(values.get('--deadline-utc'), now) };
}

export function assertBeforeDeadline(deadlineMs, now = Date.now()) {
  assert.ok(Number.isSafeInteger(deadlineMs) && now < deadlineMs,
    'deadline reached; no further QA action');
}

export function targetIssues(target) {
  if (!target) return ['missing'];
  const issues = [];
  if (!target.visible) issues.push('hidden');
  if (target.disabled || target.readOnly) issues.push('disabled-or-readonly');
  if (!target.inViewport) issues.push('outside-viewport');
  if (target.hitCount !== 9) issues.push(`hit-points-${target.hitCount ?? 'missing'}-of-9`);
  return issues;
}

export function screenshotOutcome(pathOrError) {
  if (typeof pathOrError === 'string') return { status: 'captured', path: pathOrError, visualPass: null };
  const message = pathOrError instanceof Error ? pathOrError.message : String(pathOrError);
  if (/^screenshot_page: Error: BiDi error: "unsupported operation"(?:\s|$)/i.test(message)) {
    return { status: 'unsupported', visualPass: null, reason: 'MCP BiDi chrome screenshot unsupported' };
  }
  return { status: 'error', visualPass: null, error: message };
}

export async function captureHeadlessScreenshot(harness, stage, deadlineMs, now = Date.now) {
  assertBeforeDeadline(deadlineMs, now());
  const captured = await harness.screenshot(`headless-${stage}`, {
    allowHeadlessChromeFallback: true, deadlineMs,
  });
  assertBeforeDeadline(deadlineMs, now());
  const outcome = screenshotOutcome(captured);
  const metadata = outcome.status === 'captured' ? harness.lastScreenshotMetadata : null;
  return { viewport: stage, ...outcome, route: metadata?.route ?? null,
    width: metadata?.width ?? null, height: metadata?.height ?? null };
}

export async function observeGuard(harness) {
  return chrome(harness, () => {
    const gfx = Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo);
    const api = window.__egdesk;
    return { documentURI: document.documentURI, headless: gfx.isHeadless === true,
      mounted: !!api?.surface?.snapshot && !!api?.state && !!document.getElementById('egd-canvas-viewport'),
      loggedIn: api?.state?.codex?.authStatus?.isLoggedIn === true,
      accountBound: !!api?.state?.codex?.codexAccountKey };
  });
}

export async function resizeHeadless(harness, size, deadlineMs, now = Date.now) {
  assertBeforeDeadline(deadlineMs, now());
  return chrome(harness, ({ width, height }) => {
    const gfx = Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo);
    if (gfx.isHeadless !== true || document.documentURI !== 'chrome://browser/content/browser.xhtml') {
      throw new Error('Refusing resize outside the owned headless browser Chrome window');
    }
    window.resizeTo(width + window.outerWidth - window.innerWidth,
      height + window.outerHeight - window.innerHeight);
    return { requested: { width, height }, actual: { width: window.innerWidth, height: window.innerHeight } };
  }, size);
}

export async function observeViewport(harness) {
  return chrome(harness, () => {
    const state = window.__egdesk?.state;
    return { width: window.innerWidth, height: window.innerHeight,
      camera: state && { zoom: state.zoom, zoomTarget: state.zoomTarget,
        pan: { x: state.pan.x, y: state.pan.y }, panTarget: { x: state.panTarget.x, y: state.panTarget.y } } };
  });
}

export function viewportSettled(value, size, previous) {
  const c = value?.camera;
  return value?.width === size.width && value?.height === size.height && c &&
    [c.zoom, c.zoomTarget, c.pan?.x, c.pan?.y, c.panTarget?.x, c.panTarget?.y].every(Number.isFinite) &&
    Math.abs(c.zoom - c.zoomTarget) <= 0.002 &&
    Math.abs(c.pan.x - c.panTarget.x) <= 0.5 && Math.abs(c.pan.y - c.panTarget.y) <= 0.5 &&
    (!previous || (Math.abs(c.zoom - previous.camera.zoom) <= 0.002 &&
      Math.abs(c.pan.x - previous.camera.pan.x) <= 0.5 &&
      Math.abs(c.pan.y - previous.camera.pan.y) <= 0.5));
}

export async function waitFor(harness, read, accept, deadlineMs,
  { timeoutMs = 20000, intervalMs = 80, now = Date.now, pause = sleep } = {}) {
  const end = Math.min(now() + timeoutMs, deadlineMs);
  let last;
  do {
    assertBeforeDeadline(deadlineMs, now());
    last = await read(harness);
    assertBeforeDeadline(deadlineMs, now());
    if (now() >= end) break;
    if (accept(last)) {
      assertBeforeDeadline(deadlineMs, now());
      if (now() < end) return last;
      break;
    }
    await pause(intervalMs);
  } while (now() < end);
  throw new Error(`Timed out waiting for observed headless UI state: ${JSON.stringify(last)?.slice(0, 500)}`);
}

export async function waitStableViewport(harness, size, deadlineMs, options = {}) {
  let previous = null;
  let consecutive = 0;
  return waitFor(harness, observeViewport, value => {
    consecutive = viewportSettled(value, size, previous) ? consecutive + 1 : 0;
    previous = value;
    return consecutive >= 2;
  }, deadlineMs, options);
}

export async function observeFirstUse(harness) {
  return chrome(harness, () => {
    const api = window.__egdesk;
    const state = api.state;
    const surface = api.surface.snapshot();
    const card = document.getElementById(surface.browserCardId);
    const browser = card?._xulBrowser;
    const saved = state.cardFullscreen?.cardId === card?.id ? state.cardFullscreen.rect : null;
    const px = value => Math.round(Number.parseFloat(String(value || '0')));
    const world = card && { x: px(saved?.left ?? card.style.left), y: px(saved?.top ?? card.style.top),
      width: px(saved?.width ?? card.style.width), height: px(saved?.height ?? card.style.height) };
    const rect = card?.getBoundingClientRect();
    const shown = id => {
      const node = document.getElementById(id);
      if (!node) return false;
      const box = node.getBoundingClientRect(), style = getComputedStyle(node);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    return { mode: surface.mode, initialBrowserFocus: !!surface.initialBrowserFocus,
      cardId: card?.id || null, browserCount: document.querySelectorAll('.egd-browser-card').length,
      fullscreen: state.cardFullscreen?.cardId === card?.id,
      browserContextId: browser?.browsingContext?.id ?? null,
      innerWindowId: browser?.browsingContext?.currentWindowGlobal?.innerWindowId ?? null,
      uri: card && (api.browserRuntime.state(card.id)?.uri || browser?.currentURI?.spec || null),
      sourceUri: card?._sourceRef?.uri || null,
      logicalWidth: browser?.clientWidth || 0, logicalHeight: browser?.clientHeight || 0,
      world, screen: rect && { left: rect.left, top: rect.top, right: rect.right,
        bottom: rect.bottom, width: rect.width, height: rect.height },
      zoom: state.zoomTarget, shellVisible: ['egd-desk-rail', 'egd-preset-bag', 'egd-dock'].map(shown),
      separateFirstUse: !!document.querySelector('[data-testid="first-use-root"]') };
  });
}

export async function observeSettledFirstUse(harness, size, deadlineMs,
  { settle = waitStableViewport, read = observeFirstUse, now = Date.now } = {}) {
  await settle(harness, size, deadlineMs);
  const value = await read(harness);
  assertBeforeDeadline(deadlineMs, now());
  return value;
}

export function initialFirstUseIssues(before) {
  const issues = [];
  if (before?.mode !== 'desk' || !before.initialBrowserFocus || !before.fullscreen ||
      before.browserCount !== 1 || !before.cardId || !before.browserContextId || !before.uri ||
      !Number.isSafeInteger(before.innerWindowId) || before.innerWindowId <= 0 ||
      !before.sourceUri || !before.world || before.logicalWidth <= 0 || before.logicalHeight <= 0 ||
      !before.screen || before.shellVisible?.length !== 3 || before.shellVisible.some(Boolean) ||
      before.separateFirstUse) issues.push('not-fresh-live-first-use-browser');
  return issues;
}

export function firstUseIssues(before, after) {
  const issues = initialFirstUseIssues(before);
  if (after?.mode !== 'desk' || after.initialBrowserFocus || after.fullscreen ||
      after.shellVisible?.length !== 3 || !after.shellVisible.every(Boolean) ||
      after.separateFirstUse) issues.push('zoomout-did-not-reveal-desk');
  if (after?.cardId !== before?.cardId || after?.browserContextId !== before?.browserContextId ||
      after?.innerWindowId !== before?.innerWindowId ||
      after?.uri !== before?.uri || after?.sourceUri !== before?.sourceUri ||
      after?.logicalWidth !== before?.logicalWidth || after?.logicalHeight !== before?.logicalHeight ||
      JSON.stringify(after?.world) !== JSON.stringify(before?.world)) issues.push('browser-identity-source-or-world-changed');
  if (!(after?.zoom < before?.zoom - 0.001) ||
      !(after?.screen?.width < before?.screen?.width - 80) ||
      !(after?.screen?.height < before?.screen?.height - 80)) issues.push('zoomout-geometry-not-observed');
  return issues;
}

export async function observeTargets(harness, selector) {
  return chrome(harness, ({ selector: css }) => [...document.querySelectorAll(css)].map(node => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    const inViewport = rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth &&
      rect.bottom <= window.innerHeight && rect.width > 0 && rect.height > 0;
    const visible = node.isConnected && !node.closest('[hidden], [inert], [aria-hidden="true"]') &&
      !node.closest('.egd-hud-hidden') && style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity) > 0 && rect.width > 0 && rect.height > 0;
    let hitCount = 0;
    for (const fy of [0.2, 0.5, 0.8]) for (const fx of [0.2, 0.5, 0.8]) {
      const hit = document.elementFromPoint(rect.left + rect.width * fx, rect.top + rect.height * fy);
      if (hit && (hit === node || node.contains(hit))) hitCount++;
    }
    return { id: node.dataset.id || node.getAttribute('aria-label') || node.title || node.id || null,
      visible: !!visible, disabled: !!node.disabled, readOnly: !!node.readOnly,
      inViewport, hitCount, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }), { selector });
}

export async function observeChat(harness) {
  return chrome(harness, () => {
    const api = window.__egdesk;
    const state = api.state;
    const codex = state.codex;
    const canvas = codex.chatDockMode === 'canvas';
    const root = canvas ? document.getElementById(codex.chatCardEntityId) : document.getElementById('egd-hud');
    const rect = root?.getBoundingClientRect();
    const fullyInViewport = box => !!box && box.width > 0 && box.height > 0 &&
      box.left >= 0 && box.top >= 0 && box.right <= window.innerWidth && box.bottom <= window.innerHeight;
    const rootInViewport = fullyInViewport(rect);
    const rendered = node => {
      if (!node) return { visible: false, opacity: 0 };
      let opacity = 1;
      for (let current = node; current;
        current = current.parentElement || current.getRootNode?.().host || null) {
        const style = getComputedStyle(current);
        const alpha = Number(style.opacity);
        if (style.display === 'none' || style.visibility !== 'visible' ||
            !Number.isFinite(alpha) || alpha <= 0) return { visible: false, opacity: 0 };
        opacity *= alpha;
      }
      return { visible: opacity > 0, opacity };
    };
    const rootRendering = rendered(root);
    const activeProjection = !!root && (canvas || (state.hudOpen && state.hudApp === 'chat' &&
      !root.classList.contains('egd-hud-hidden'))) && rootRendering.visible &&
      rect.width > 0 && rect.height > 0 &&
      (canvas ? rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth &&
        rect.top < window.innerHeight : rootInViewport);
    const input = activeProjection ? root.querySelector('.egd-codex-input') : null;
    const inputRect = input?.getBoundingClientRect();
    const composer = activeProjection ? root.querySelector('.egd-codex-footer') : null;
    const composerRect = composer?.getBoundingClientRect();
    const zoomRect = document.getElementById('egd-zoom-indicator')?.getBoundingClientRect();
    const composerZoomOverlapArea = composerRect && zoomRect
      ? Math.max(0, Math.min(composerRect.right, zoomRect.right) - Math.max(composerRect.left, zoomRect.left)) *
        Math.max(0, Math.min(composerRect.bottom, zoomRect.bottom) - Math.max(composerRect.top, zoomRect.top))
      : null;
    const inputInViewport = fullyInViewport(inputRect);
    const inputRendering = rendered(input);
    const inputVisible = !!input && inputInViewport && inputRendering.visible;
    let inputHitCount = 0;
    if (inputVisible) {
      for (const fy of [0.2, 0.5, 0.8]) for (const fx of [0.2, 0.5, 0.8]) {
        const hit = document.elementFromPoint(inputRect.left + inputRect.width * fx,
          inputRect.top + inputRect.height * fy);
        if (hit && (hit === input || input.contains(hit))) inputHitCount++;
      }
    }
    const bounds = box => box && { left: box.left, top: box.top, right: box.right,
      bottom: box.bottom, width: box.width, height: box.height };
    const px = value => Number.parseFloat(value);
    const world = canvas && root && { x: px(root.style.left), y: px(root.style.top),
      width: px(root.style.width), height: px(root.style.height) };
    const presentationHeight = world && Math.min(world.height,
      Number.isFinite(px(root.style.maxHeight)) ? px(root.style.maxHeight) : world.height);
    const threadId = codex.activeThreadId || null;
    const thread = codex.threads.find(item => item.id === threadId);
    return { mode: codex.chatDockMode, cardId: codex.chatCardEntityId || null,
      rootId: root?.id || null, activeProjection, rootInViewport,
      rootRendered: rootRendering.visible,
      rootEffectiveOpacity: rootRendering.opacity, rootRect: bounds(rect),
      inputVisible, inputInViewport, inputEffectiveOpacity: inputRendering.opacity, inputHitCount,
      inputRect: bounds(inputRect), inputDisabled: !!input?.disabled,
      composerRect: bounds(composerRect), composerInViewport: fullyInViewport(composerRect),
      zoomRect: bounds(zoomRect), composerZoomOverlapArea, world, presentationHeight,
      inputReadOnly: !!input?.readOnly, inputThreadId: input?.dataset.threadId || null,
      inputValue: input?.value ?? null, draft: threadId ? codex.threadDrafts[threadId] || '' : null,
      threadId, messageCount: thread?.messages?.length ?? null,
      renderedMessageCount: activeProjection ? root.querySelectorAll('.egd-codex-message-row').length : null,
      isSending: !!codex.isSending, loggedIn: !!codex.authStatus?.isLoggedIn,
      camera: { zoom: state.zoom, zoomTarget: state.zoomTarget,
        pan: { x: state.pan.x, y: state.pan.y }, panTarget: { x: state.panTarget.x, y: state.panTarget.y } } };
  });
}

function record(result, label, passed, details = undefined) {
  result.checks.push({ label, passed: !!passed, ...(details === undefined ? {} : { details }) });
  return !!passed;
}

function requireCheck(result, label, passed, details) {
  if (!record(result, label, passed, details)) throw new Error(label);
}

async function safeClick(harness, selector, label, size, deadlineMs, result) {
  assertBeforeDeadline(deadlineMs);
  await waitStableViewport(harness, size, deadlineMs);
  const targets = await observeTargets(harness, selector);
  assertBeforeDeadline(deadlineMs);
  requireCheck(result, `${label}: one visible unobstructed native target`,
    targets.length === 1 && targetIssues(targets[0]).length === 0,
    { count: targets.length, issues: targetIssues(targets[0]), rect: targets[0]?.rect });
  assertBeforeDeadline(deadlineMs);
  await harness.click(selector); // One native action only. Timeout does not imply cancellation; never retry.
  result.actions.push(label);
  return waitStableViewport(harness, size, deadlineMs);
}

async function safeFill(harness, selector, value, size, deadlineMs, result) {
  assertBeforeDeadline(deadlineMs);
  await waitStableViewport(harness, size, deadlineMs);
  const targets = await observeTargets(harness, selector);
  assertBeforeDeadline(deadlineMs);
  requireCheck(result, 'Chat: one visible unobstructed active composer',
    targets.length === 1 && targetIssues(targets[0]).length === 0,
    { count: targets.length, issues: targetIssues(targets[0]), rect: targets[0]?.rect });
  assertBeforeDeadline(deadlineMs);
  await harness.fill(selector, value);
  result.actions.push('fill offline Chat draft');
}

export function chatIssues(value, { mode, threadId, draft, messageCount }) {
  const issues = [];
  if (value?.mode !== mode || !value.activeProjection || !value.inputVisible ||
      !value.inputInViewport || value.inputHitCount !== 9 ||
      (mode === 'hud' && (!value.rootInViewport || !value.rootRendered ||
        !(value.rootEffectiveOpacity > 0))) ||
      value.inputDisabled || value.inputReadOnly) issues.push('inactive-or-unusable-chat-projection');
  if (!value?.threadId || value.threadId !== threadId || value.inputThreadId !== threadId)
    issues.push('logical-thread-mismatch');
  if (value?.inputValue !== draft || value?.draft !== draft) issues.push('draft-mismatch');
  if (value?.messageCount !== messageCount || value.isSending) issues.push('message-count-or-send-changed');
  if (value?.loggedIn) issues.push('real-credentials-present');
  return issues;
}

export function canvasComposerClearanceIssues(value) {
  if (value?.mode !== 'canvas') return ['not-canvas-chat'];
  const issues = [];
  if (!value.composerRect || !value.zoomRect || !Number.isFinite(value.composerZoomOverlapArea))
    issues.push('missing-composer-or-zoom-rect');
  if (!value.composerInViewport) issues.push('composer-outside-viewport');
  if (value.composerZoomOverlapArea > 0) issues.push('composer-zoom-overlap');
  return issues;
}

export function sameWorldGeometry(before, after) {
  return ['x', 'y', 'width', 'height'].every(key =>
    Number.isFinite(before?.[key]) && before[key] === after?.[key]);
}

export function presentationRestoredOnWiderViewport(prior, current) {
  if (!Number.isFinite(prior?.world?.height) || !Number.isFinite(prior.presentationHeight) ||
      !Number.isFinite(current?.presentationHeight)) return false;
  const wasCapped = prior.presentationHeight < prior.world.height - 0.5;
  return current.presentationHeight >= prior.presentationHeight - 0.5 &&
    (!wasCapped || current.presentationHeight > prior.presentationHeight + 0.5);
}

export function projectionGeometrySettled(before, after) {
  return ['rootRect', 'inputRect'].every(key =>
    ['left', 'top', 'right', 'bottom', 'width', 'height'].every(part =>
      Number.isFinite(before?.[key]?.[part]) && Number.isFinite(after?.[key]?.[part]) &&
      Math.abs(before[key][part] - after[key][part]) <= 0.5));
}

async function scanControls(harness, size, deadlineMs, result, stage) {
  await waitStableViewport(harness, size, deadlineMs);
  const dock = await observeTargets(harness, '#egd-dock .egd-dock-btn');
  assertBeforeDeadline(deadlineMs);
  const zoom = await observeTargets(harness, '#egd-zoom-indicator .egd-zoom-button');
  assertBeforeDeadline(deadlineMs);
  for (const [name, expected, observed] of [['Dock', DOCK_IDS, dock], ['Zoom', ZOOM_LABELS, zoom]]) {
    record(result, `${stage}: ${name} control inventory`, observed.length === expected.length &&
      expected.every(id => observed.filter(item => item.id === id).length === 1),
    { expected, observed: observed.map(item => item.id) });
    for (const id of expected) {
      const items = observed.filter(item => item.id === id);
      record(result, `${stage}: ${name} ${id} 3x3 in-viewport hit target`,
        items.length === 1 && targetIssues(items[0]).length === 0,
        { issues: targetIssues(items[0]), rect: items[0]?.rect });
    }
  }
  return { dock, zoom };
}

async function chatRoundTrip(harness, size, deadlineMs, result, priorThreadId) {
  await safeClick(harness, '#egd-dock .egd-dock-btn[data-id="chat"]', 'open/focus Chat from Dock', size, deadlineMs, result);
  const canvas = await waitFor(harness, observeChat, value => value.mode === 'canvas' &&
    value.activeProjection && value.inputVisible && !!value.threadId, deadlineMs);
  const threadId = priorThreadId || canvas.threadId;
  const messageCount = canvas.messageCount;
  requireCheck(result, 'Canvas Chat is fresh/offline and bound to one logical thread',
    !!threadId && canvas.threadId === threadId && canvas.inputThreadId === threadId &&
    messageCount === 0 && !canvas.loggedIn && !canvas.isSending &&
    (priorThreadId || (canvas.inputValue === '' && canvas.draft === '')),
    { mode: canvas.mode, threadId: canvas.threadId, messageCount, inputThreadId: canvas.inputThreadId });
  const canvasSelector = `[id=${JSON.stringify(canvas.cardId)}]`;
  if (!priorThreadId) {
    await safeFill(harness, `${canvasSelector} .egd-codex-input`, DRAFT, size, deadlineMs, result);
  }
  const drafted = await waitFor(harness, observeChat, value =>
    chatIssues(value, { mode: 'canvas', threadId, draft: DRAFT, messageCount }).length === 0, deadlineMs);
  requireCheck(result, 'Canvas draft and zero messages read back',
    chatIssues(drafted, { mode: 'canvas', threadId, draft: DRAFT, messageCount }).length === 0);
  const canvasClearance = await observeChat(harness);
  assertBeforeDeadline(deadlineMs);
  requireCheck(result, `${size.width}x${size.height}: Canvas composer/Zoom actual rectangles do not intersect`,
    canvasComposerClearanceIssues(canvasClearance).length === 0 &&
      canvasClearance.cardId === canvas.cardId && sameWorldGeometry(canvas.world, canvasClearance.world),
    { issues: canvasComposerClearanceIssues(canvasClearance), composer: canvasClearance.composerRect,
      zoom: canvasClearance.zoomRect, overlapArea: canvasClearance.composerZoomOverlapArea,
      beforeWorld: canvas.world, afterWorld: canvasClearance.world });
  await safeClick(harness, `${canvasSelector} button[title="우측 패널로 이동"]`,
    'Canvas Chat to HUD', size, deadlineMs, result);
  let previousHud = null;
  const hud = await waitFor(harness, observeChat, value => {
    const ready = value.mode === 'hud' && value.cardId === null &&
      chatIssues(value, { mode: 'hud', threadId, draft: DRAFT, messageCount }).length === 0;
    const settled = ready && projectionGeometrySettled(previousHud, value);
    previousHud = ready ? value : null;
    return settled;
  }, deadlineMs, { intervalMs: 240 });
  requireCheck(result, 'HUD preserves logical thread, draft, message count',
    chatIssues(hud, { mode: 'hud', threadId, draft: DRAFT, messageCount }).length === 0,
    { issues: chatIssues(hud, { mode: 'hud', threadId, draft: DRAFT, messageCount }), camera: hud.camera });
  requireCheck(result, 'HUD composer fully in viewport with 3x3 hit target after 240ms stable projection',
    hud.rootInViewport && hud.inputInViewport && hud.inputHitCount === 9,
    { rootRect: hud.rootRect, inputRect: hud.inputRect, hitCount: hud.inputHitCount });
  await scanControls(harness, size, deadlineMs, result, `${size.width}x${size.height} HUD-open`);
  const hudAfterScan = await observeChat(harness);
  assertBeforeDeadline(deadlineMs);
  requireCheck(result, 'Dock/Zoom rescan occurred with usable HUD still open',
    hudAfterScan.mode === 'hud' && hudAfterScan.cardId === null &&
      chatIssues(hudAfterScan, { mode: 'hud', threadId, draft: DRAFT, messageCount }).length === 0,
    { issues: chatIssues(hudAfterScan, { mode: 'hud', threadId, draft: DRAFT, messageCount }) });
  for (const selector of ['#egd-hud:not(.egd-hud-hidden) .egd-hud-pin',
    '#egd-hud:not(.egd-hud-hidden) .egd-hud-close']) {
    const target = await observeTargets(harness, selector);
    assertBeforeDeadline(deadlineMs);
    record(result, `HUD ${selector.includes('pin') ? 'pin' : 'close'} 3x3 hit target`,
      target.length === 1 && targetIssues(target[0]).length === 0,
      { issues: targetIssues(target[0]), rect: target[0]?.rect });
  }
  await safeClick(harness, '#egd-hud:not(.egd-hud-hidden) .egd-hud-pin',
    'HUD Chat back to Canvas', size, deadlineMs, result);
  const returned = await waitFor(harness, observeChat, value => value.mode === 'canvas' &&
    !!value.cardId && chatIssues(value, { mode: 'canvas', threadId, draft: DRAFT,
      messageCount }).length === 0, deadlineMs);
  requireCheck(result, 'Canvas return preserves logical thread, draft, message count',
    chatIssues(returned, { mode: 'canvas', threadId, draft: DRAFT, messageCount }).length === 0,
    { issues: chatIssues(returned, { mode: 'canvas', threadId, draft: DRAFT, messageCount }),
      oldCardId: canvas.cardId, currentCardId: returned.cardId, camera: returned.camera });
  requireCheck(result, `${size.width}x${size.height}: returned Canvas composer/Zoom rectangles do not intersect`,
    canvasComposerClearanceIssues(returned).length === 0,
    { issues: canvasComposerClearanceIssues(returned), composer: returned.composerRect,
      zoom: returned.zoomRect, overlapArea: returned.composerZoomOverlapArea });
  requireCheck(result, `${size.width}x${size.height}: returned Chat saved and presentation heights observed`,
    sameWorldGeometry(returned.world, returned.world) && Number.isFinite(returned.presentationHeight) &&
      returned.presentationHeight > 0 && returned.presentationHeight <= returned.world.height,
    { world: returned.world, presentationHeight: returned.presentationHeight });
  // Never reuse canvasSelector: moving through HUD may replace the Card DOM ID.
  return { threadId, messageCount, oldCardId: canvas.cardId, currentCardId: returned.cardId,
    world: returned.world, presentationHeight: returned.presentationHeight,
    camera: { before: canvas.camera, hud: hud.camera, after: returned.camera } };
}

export async function runRegression({ harness, profile, deadlineMs, viewports = VIEWPORTS, result = {
  kind: 'firefox-mcp-headless-ui-regression', ok: false,
    profile, marionettePort: 2829, providerTurn: 'not-run', visualPass: null,
    screenshot: { status: 'pending', visualPass: null },
    checks: [], actions: [], skippedActions: [], viewports: [], screenshots: [] } }) {
  assertBeforeDeadline(deadlineMs);
  requireCheck(result, 'exact QA profile and port 2829',
    harness.profile === profile && harness.marionettePort === 2829);
  const guard = await observeGuard(harness);
  assertBeforeDeadline(deadlineMs);
  requireCheck(result, 'owned headless browser Chrome, mounted Desk, no real credentials',
    guard.documentURI === 'chrome://browser/content/browser.xhtml' && guard.headless &&
    guard.mounted && !guard.loggedIn && !guard.accountBound, guard);

  const firstSize = viewports[0];
  await resizeHeadless(harness, firstSize, deadlineMs);
  await waitStableViewport(harness, firstSize, deadlineMs);
  const before = await observeFirstUse(harness);
  assertBeforeDeadline(deadlineMs);
  requireCheck(result, 'fresh profile begins with one live first-use Browser',
    initialFirstUseIssues(before).length === 0,
    { cardId: before.cardId, browserContextId: before.browserContextId, uri: before.uri });
  assertBeforeDeadline(deadlineMs);
  await harness.press('meta+-');
  result.actions.push('native first-use meta+-');
  await waitFor(harness, observeFirstUse, value => !value.initialBrowserFocus &&
    !value.fullscreen && value.shellVisible?.every(Boolean), deadlineMs);
  const after = await observeSettledFirstUse(harness, firstSize, deadlineMs);
  requireCheck(result, 'first-use zoom-out retains Browser identity, source URL, logical size and world geometry',
    firstUseIssues(before, after).length === 0, { issues: firstUseIssues(before, after), before, after });

  let threadId = null;
  let previousCanvas = null;
  for (const size of viewports) {
    assertBeforeDeadline(deadlineMs);
    await resizeHeadless(harness, size, deadlineMs);
    const settled = await waitStableViewport(harness, size, deadlineMs);
    const stage = `${size.width}x${size.height}`;
    const frame = { size, actual: { width: settled.width, height: settled.height },
      cameraBefore: settled.camera, cameraAfterZoom: null, fitAll: null, chat: null };
    result.viewports.push(frame);
    requireCheck(result, `${stage}: exact real inner viewport`,
      settled.width === size.width && settled.height === size.height, frame.actual);
    if (previousCanvas) {
      const resizedChat = await observeChat(harness);
      assertBeforeDeadline(deadlineMs);
      requireCheck(result, `${stage}: resize preserves the same Chat Card and saved world geometry`,
        resizedChat.mode === 'canvas' && resizedChat.cardId === previousCanvas.cardId &&
          sameWorldGeometry(previousCanvas.world, resizedChat.world),
        { prior: previousCanvas, current: { cardId: resizedChat.cardId, world: resizedChat.world } });
      if (size.height > previousCanvas.size.height) {
        requireCheck(result, `${stage}: wider viewport restores Chat presentation height`,
          presentationRestoredOnWiderViewport(previousCanvas, resizedChat),
          { savedHeight: resizedChat.world.height, priorPresentation: previousCanvas.presentationHeight,
            currentPresentation: resizedChat.presentationHeight, priorSize: previousCanvas.size });
      }
    }
    const controls = await scanControls(harness, size, deadlineMs, result, stage);
    const zoomSafe = label => targetIssues(controls.zoom.find(item => item.id === label)).length === 0;
    if (zoomSafe('Canvas 확대') && zoomSafe('Canvas 축소')) {
      const prior = await observeViewport(harness);
      assertBeforeDeadline(deadlineMs);
      await safeClick(harness, '#egd-zoom-indicator .egd-zoom-button[aria-label="Canvas 확대"]',
        `${stage}: native Zoom+`, size, deadlineMs, result);
      const zoomed = await observeViewport(harness);
      assertBeforeDeadline(deadlineMs);
      record(result, `${stage}: Zoom+ changed actual camera`, zoomed.camera.zoom > prior.camera.zoom + 0.001,
        { before: prior.camera, after: zoomed.camera });
      await safeClick(harness, '#egd-zoom-indicator .egd-zoom-button[aria-label="Canvas 축소"]',
        `${stage}: native Zoom-`, size, deadlineMs, result);
      const reduced = await observeViewport(harness);
      assertBeforeDeadline(deadlineMs);
      record(result, `${stage}: Zoom- changed actual camera`, reduced.camera.zoom < zoomed.camera.zoom - 0.001,
        { before: zoomed.camera, after: reduced.camera });
    } else result.skippedActions.push(`${stage}: Zoom pair skipped: unsafe hit target`);
    if (zoomSafe('열린 창 전체 보기')) {
      await safeClick(harness, '#egd-zoom-indicator .egd-zoom-button[aria-label="열린 창 전체 보기"]',
        `${stage}: native Fit All click only (fit geometry unverified)`, size, deadlineMs, result);
      frame.fitAll = { status: 'click-only', fitPass: null };
    } else {
      frame.fitAll = { status: 'skipped-unsafe-target', fitPass: null };
      result.skippedActions.push(`${stage}: Fit All skipped: unsafe hit target`);
    }
    frame.cameraAfterZoom = (await observeViewport(harness)).camera;
    assertBeforeDeadline(deadlineMs);
    frame.chat = await chatRoundTrip(harness, size, deadlineMs, result, threadId);
    threadId = frame.chat.threadId;
    previousCanvas = { size, cardId: frame.chat.currentCardId,
      world: frame.chat.world, presentationHeight: frame.chat.presentationHeight };
    assertBeforeDeadline(deadlineMs);
    try {
      result.screenshots.push(await captureHeadlessScreenshot(harness, stage, deadlineMs));
    } catch (error) {
      assertBeforeDeadline(deadlineMs);
      const outcome = screenshotOutcome(error);
      result.screenshots.push({ viewport: stage, ...outcome, route: null, width: null, height: null });
      result.screenshot = { status: outcome.status, visualPass: null };
      if (outcome.status === 'error') throw error;
    }
  }
  const statuses = new Set(result.screenshots.map(item => item.status));
  result.screenshot = { status: statuses.size === 1 ? [...statuses][0] : 'mixed', visualPass: null };
  assertBeforeDeadline(deadlineMs);
  result.ok = result.checks.every(item => item.passed);
  return result;
}

export async function runCli(argv = process.argv.slice(2)) {
  let harness;
  let result = { kind: 'firefox-mcp-headless-ui-regression', ok: false,
    providerTurn: 'not-run', visualPass: null,
    screenshot: { status: 'pending', visualPass: null },
    checks: [], actions: [], skippedActions: [], viewports: [], screenshots: [] };
  try {
    const { profile, deadlineMs } = parseCli(argv);
    const manifest = assertQaFixtureManifest(profile);
    assert.equal(manifest.deskRecovery, null, 'fresh headless QA profile must not contain recovery state');
    assertBeforeDeadline(deadlineMs);
    harness = new FirefoxMcpChatHarness({ profile, marionettePort: 2829 });
    assertBeforeDeadline(deadlineMs);
    await harness.connect();
    result.profile = profile;
    result.marionettePort = 2829;
    await runRegression({ harness, profile, deadlineMs, result });
  } catch (error) {
    result.ok = false;
    result.error = error.message;
  } finally {
    try { await harness?.close(); }
    catch (error) { result.ok = false; result.closeError = error.message; }
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
  return result;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await runCli();
