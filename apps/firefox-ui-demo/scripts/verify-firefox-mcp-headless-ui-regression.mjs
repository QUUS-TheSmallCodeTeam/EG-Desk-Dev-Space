#!/usr/bin/env node
// Attach-only, model-free QA for Main's already-running headless Firefox.
// UI input uses FirefoxMcpChatHarness native MCP tools; Chrome evaluation only
// observes state, except for the explicitly bounded headless window resize.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { FirefoxMcpChatHarness, captureQaScreenshot } from './firefox-mcp-chat-harness.mjs';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { chrome } from './egdesk-qa-ui-flow.mjs';

export const VIEWPORTS = Object.freeze([
  { width: 800, height: 600 },
  { width: 600, height: 600 },
  { width: 960, height: 700 },
  { width: 1280, height: 776 },
]);
// The approved eight-button Dock. 파일·개발 (IDE)·온톨로지·설정 and the drawing
// tools open from the 새 카드 menu (#egd-dock-menu).
const DOCK_IDS = Object.freeze(['chat', 'memo', 'browser', 'terminal', 'select', 'hand', 'create', 'trash']);
const ZOOM_LABELS = Object.freeze(['Canvas 축소', 'Canvas 확대', '열린 창 전체 보기']);
const DRAFT = 'EG-Desk headless QA draft — never send';
export const NARROW_CHAT_SAMPLE = ' QA600';
export const NARROW_CHAT_WHEEL_LIMIT = 4;
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
  let captured, metadata;
  try {
    captured = await harness.screenshot(`headless-${stage}`, {
      allowHeadlessChromeFallback: true, deadlineMs,
    });
    metadata = harness.lastScreenshotMetadata;
  } catch (error) {
    // Firefox 158 may append this exact explanation to the same unsupported
    // privileged-scope screenshot response. Normalize only that observed
    // response into the existing bounded, headless-only drawSnapshot fallback.
    if (error?.message !== 'screenshot_page: Error: BiDi error: "unsupported operation": The command does not support browsing contexts in privileged scope') throw error;
    metadata = await captureQaScreenshot({
      name: `headless-${stage}`, evidenceDir: harness.evidenceDir,
      assertRemoteProfile: () => harness.assertRemoteProfile(),
      screenshotPage: async () => { throw new Error('screenshot_page: Error: BiDi error: "unsupported operation"'); },
      evaluateChrome: source => harness.evaluateChrome(source), allowHeadlessChromeFallback: true, deadlineMs,
    });
    captured = metadata.path;
  }
  assertBeforeDeadline(deadlineMs, now());
  const outcome = screenshotOutcome(captured);
  if (outcome.status !== 'captured') metadata = null;
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
      title: node.title || '', ariaLabel: node.getAttribute('aria-label') || '',
      visible: !!visible, disabled: !!node.disabled, readOnly: !!node.readOnly,
      inViewport, hitCount, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
  }), { selector });
}

// Readback for Main's native Dock zoom / Browser toolbar QA. This never asks
// the content actor for an observation, metrics refresh, refs, or authority.
export async function observeBrowserPresentation(harness, cardId) {
  assert.match(cardId, /^egd-browser-card-\d+$/);
  return chrome(harness, ({ cardId: id }) => {
    const card = document.getElementById(id);
    if (!card?.classList.contains('egd-browser-card')) return null;
    const browser = card._xulBrowser;
    const rect = card.getBoundingClientRect();
    const zoom = window.__egdesk.state.zoom;
    const font = selector => {
      const node = card.querySelector(selector);
      return node ? Number.parseFloat(getComputedStyle(node).fontSize) * zoom : null;
    };
    const controls = [...card.querySelectorAll('.egd-card-header button, .egd-card-header [role="button"]')]
      .filter(node => !node.disabled && node.getAttribute('aria-disabled') !== 'true')
      .map(node => {
        const box = node.getBoundingClientRect();
        let hits = 0;
        for (const y of [.2, .5, .8]) for (const x of [.2, .5, .8]) {
          const hit = document.elementFromPoint(box.left + box.width * x, box.top + box.height * y);
          if (hit && (hit === node || node.contains(hit))) hits++;
        }
        return { label: node.getAttribute('aria-label') || node.title || node.className,
          width: box.width, height: box.height, hits };
      });
    const px = value => Number.parseFloat(value);
    return { cardId: id, level: card.dataset.egdSemanticLevel, zoom,
      world: { x: px(card.style.left), y: px(card.style.top),
        width: px(card.style.width), height: px(card.style.height) },
      screen: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      contextId: browser?.browsingContext?.id ?? null,
      innerWindowId: browser?.browsingContext?.currentWindowGlobal?.innerWindowId ?? null,
      logicalWidth: browser?.clientWidth, logicalHeight: browser?.clientHeight,
      pageZoom: browser?.fullZoom ?? null,
      contentFontPx: card._browserPresentation?.font() ?? null,
      metrics: card._browserPresentation?.read() ?? null,
      cache: card._browserPresentation?.diagnostics() ?? null,
      titleFontPx: font('.egd-card-page-title'), addressFontPx: font('.egd-card-url'), controls };
  }, { cardId });
}

export function browserPresentationIssues(before, after, { expectDetail = true } = {}) {
  const issues = [];
  if (!before || !after || !before.contextId || !before.innerWindowId ||
      ['cardId', 'contextId', 'innerWindowId', 'logicalWidth', 'logicalHeight', 'pageZoom']
        .some(key => before[key] !== after[key]) ||
      JSON.stringify(before.world) !== JSON.stringify(after.world)) issues.push('browser-identity-viewport-or-world-changed');
  if (expectDetail) {
    if (after?.level !== 'detail' || !(after.contentFontPx >= 9)) issues.push('readable-content-not-detail');
    if (!(after?.titleFontPx >= 10.5) || !(after.addressFontPx >= 10.5)) issues.push('two-row-bar-font-too-small');
    if (!after?.controls?.length || after.controls.some(control => control.width < 31.5 ||
      control.height < 31.5 || control.hits !== 9)) issues.push('two-row-bar-target-unusable');
  } else if (after?.level === 'detail') issues.push('unreadable-content-not-compact');
  return issues;
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

// Only the new reachability phase uses this point-input path. The original
// baseline keeps its existing UID actions and assertions unchanged.
export async function observeReachabilityDockPoint(harness) {
  return chrome(harness, () => [...document.querySelectorAll('#egd-dock .egd-dock-btn[data-id="chat"]')].map(node => {
    const r = node.getBoundingClientRect(), point = { x: Math.floor(r.left + r.width / 2), y: Math.floor(r.top + r.height / 2) };
    const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    let visible = node.isConnected && !node.closest('[hidden],[inert],[aria-hidden="true"]');
    for (let parent = node; parent; parent = parent.parentElement) {
      const css = getComputedStyle(parent), p = parent.getBoundingClientRect();
      if (css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) <= 0) visible = false;
      if (parent === node || css.display === 'inline' || css.display === 'contents') continue;
      const sx = parent.offsetWidth ? p.width / parent.offsetWidth : 1, sy = parent.offsetHeight ? p.height / parent.offsetHeight : 1;
      if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
        clip.left = Math.max(clip.left, p.left + parent.clientLeft * sx);
        clip.right = Math.min(clip.right, p.left + (parent.clientLeft + parent.clientWidth) * sx);
      }
      if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
        clip.top = Math.max(clip.top, p.top + parent.clientTop * sy);
        clip.bottom = Math.min(clip.bottom, p.top + (parent.clientTop + parent.clientHeight) * sy);
      }
    }
    const owned = (x, y) => { const hit = document.elementFromPoint(x, y); return !!hit && (hit === node || node.contains(hit)); };
    let hitCount = 0;
    for (const fy of [0.2, 0.5, 0.8]) for (const fx of [0.2, 0.5, 0.8]) if (owned(r.left + r.width * fx, r.top + r.height * fy)) hitCount++;
    return { id: node.dataset.id, visible, disabled: !!node.disabled, readOnly: !!node.readOnly, hitCount,
      inViewport: r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
      clipped: r.left < clip.left - 0.5 || r.top < clip.top - 0.5 || r.right > clip.right + 0.5 || r.bottom > clip.bottom + 0.5,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height }, point, pointHit: owned(point.x, point.y),
      viewport: { width: innerWidth, height: innerHeight } };
  }));
}

export async function focusChatDockForReachability(harness, size, deadlineMs, result, {
  read = observeReachabilityDockPoint, pause = sleep, now = Date.now, capture = captureHeadlessScreenshot,
} = {}) {
  const proof = { size, observations: [], dispatched: false, clickCount: 0 };
  (result.reachabilityDockFocus ||= []).push(proof);
  try {
    for (let index = 0; index < 2; index++) {
      assertBeforeDeadline(deadlineMs, now());
      const targets = await read(harness); proof.observations.push(targets);
      assertBeforeDeadline(deadlineMs, now());
      const target = targets[0];
      requireCheck(result, `${size.width}x${size.height}: reachability Dock point preflight ${index + 1}`,
        targets.length === 1 && target?.id === 'chat' && targetIssues(target).length === 0 && target.clipped === false &&
        target.pointHit === true && ['x', 'y'].every(key => Number.isSafeInteger(target.point?.[key])) &&
        ['x', 'y', 'width', 'height'].every(key => Number.isFinite(target.rect?.[key])) &&
        target.point.x === Math.floor(target.rect.x + target.rect.width / 2) &&
        target.point.y === Math.floor(target.rect.y + target.rect.height / 2) &&
        target.point.x >= 0 && target.point.y >= 0 && target.point.x < size.width && target.point.y < size.height &&
        target.viewport?.width === size.width && target.viewport?.height === size.height, targets);
      if (index === 0) await pause(120);
    }
    const [before, after] = proof.observations.map(targets => targets[0]);
    requireCheck(result, `${size.width}x${size.height}: reachability Dock geometry and exact hit point stable`,
      JSON.stringify(before.rect) === JSON.stringify(after.rect) && JSON.stringify(before.point) === JSON.stringify(after.point), { before, after });
    assertBeforeDeadline(deadlineMs, now());
    proof.dispatched = true; proof.clickCount = 1;
    await harness.clickPoint(after.point); // Exactly once; no UID lookup, auto-scroll or input retry.
    assertBeforeDeadline(deadlineMs, now());
    proof.completed = true;
    result.actions.push(`${size.width}x${size.height}: one stable native Chat Dock point click for reachability`);
    return proof;
  } catch (error) {
    proof.error = error.message; proof.completed = false;
    try { if (now() < deadlineMs) proof.failureCapture = await capture(harness, `${size.width}x${size.height}-chat-dock-point-failure`, deadlineMs, now); }
    catch (captureError) { proof.captureError = captureError.message; }
    throw error;
  }
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

// Read-only witness, separate from the baseline observer so existing projection
// checks remain unchanged. Textarea value is not a DOM text node: endpoint and
// line-space evidence is automatic; final glyph legibility needs image review.
export async function observeChatReachability(harness) {
  return chrome(harness, () => {
    const state = window.__egdesk?.state, codex = state?.codex;
    const thread = codex?.threads?.find(item => item.id === codex.activeThreadId);
    const root = codex?.chatDockMode === 'canvas' ? document.getElementById(codex.chatCardEntityId) : null;
    const inputs = [...(root?.querySelectorAll('textarea.egd-codex-input[data-testid="chat-composer"]') || [])];
    const logs = [...(root?.querySelectorAll('.egd-codex-messages') || [])];
    const input = inputs.length === 1 ? inputs[0] : null, messages = logs.length === 1 ? logs[0] : null;
    const logins = [...(messages?.querySelectorAll('.egd-codex-empty-actions button.egd-codex-chip-primary') || [])]
      .filter(node => node.textContent.trim() === '로그인');
    const login = logins.length === 1 ? logins[0] : null;
    const rectOf = r => r && ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height });
    const bounds = node => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      let shown = node.isConnected && !node.closest('[hidden],[inert],[aria-hidden="true"]');
      for (let parent = node; parent; parent = parent.parentElement) {
        const css = getComputedStyle(parent), r = parent.getBoundingClientRect();
        if (css.display === 'none' || css.visibility !== 'visible' || Number(css.opacity) <= 0) shown = false;
        if (parent === node) continue; // Own borders are not ancestor clipping.
        if (css.display === 'inline' || css.display === 'contents') continue;
        const sx = parent.offsetWidth ? r.width / parent.offsetWidth : 1, sy = parent.offsetHeight ? r.height / parent.offsetHeight : 1;
        if (/(auto|scroll|hidden|clip)/.test(css.overflowX)) {
          clip.left = Math.max(clip.left, r.left + parent.clientLeft * sx);
          clip.right = Math.min(clip.right, r.left + (parent.clientLeft + parent.clientWidth) * sx);
        }
        if (/(auto|scroll|hidden|clip)/.test(css.overflowY)) {
          clip.top = Math.max(clip.top, r.top + parent.clientTop * sy);
          clip.bottom = Math.min(clip.bottom, r.top + (parent.clientTop + parent.clientHeight) * sy);
        }
      }
      const inside = r => r.width > 0 && r.height > 0 && r.left >= clip.left - 0.5 && r.top >= clip.top - 0.5 &&
        r.right <= clip.right + 0.5 && r.bottom <= clip.bottom + 0.5;
      let hits = 0;
      for (const fy of [0.2, 0.5, 0.8]) for (const fx of [0.2, 0.5, 0.8]) {
        const hit = document.elementFromPoint(rect.left + rect.width * fx, rect.top + rect.height * fy);
        if (hit && (hit === node || node.contains(hit))) hits++;
      }
      let wheelPoint = null;
      const left = Math.max(rect.left, clip.left), right = Math.min(rect.right, clip.right);
      const top = Math.max(rect.top, clip.top), bottom = Math.min(rect.bottom, clip.bottom);
      if (shown && right - left > 4 && bottom - top > 4) for (const fy of [0.5, 0.25, 0.75]) for (const fx of [0.5, 0.25, 0.75]) {
        const x = Math.floor(left + (right - left) * fx), y = Math.floor(top + (bottom - top) * fy);
        const hit = document.elementFromPoint(x, y);
        if (!wheelPoint && hit && (hit === node || node.contains(hit))) wheelPoint = { x, y };
      }
      return { shown, rect: rectOf(rect), clip, fullyVisible: shown && inside(rect), hitCount: hits, wheelPoint,
        scaleY: node.offsetHeight ? rect.height / node.offsetHeight : 1,
        disabled: !!node.disabled, readOnly: !!node.readOnly,
        scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight,
        nativeScrollTopMax: Number.isFinite(node.scrollTopMax) ? node.scrollTopMax : null };
    };
    const textFragments = [];
    let missingTextRects = 0;
    if (login) {
      const walker = document.createTreeWalker(login, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.data.trim()) continue;
        const range = document.createRange(); range.selectNodeContents(node);
        const rects = [...range.getClientRects()].filter(r => r.width > 0 && r.height > 0);
        if (!rects.length) missingTextRects++;
        for (const r of rects) {
          const clip = bounds(login).clip;
          let hitCount = 0;
          for (const fraction of [0.2, 0.5, 0.8]) {
            const hit = document.elementFromPoint(r.left + r.width * fraction, r.top + r.height / 2);
            if (hit && (hit === login || login.contains(hit))) hitCount++;
          }
          textFragments.push({ text: node.data, rect: rectOf(r), hitCount,
            inside: r.left >= clip.left - 0.5 && r.top >= clip.top - 0.5 && r.right <= clip.right + 0.5 && r.bottom <= clip.bottom + 0.5 });
        }
        range.detach?.();
      }
    }
    const css = input && getComputedStyle(input), px = value => Number.parseFloat(value);
    const inputBox = bounds(input), send = root?.querySelector('[data-testid="chat-send"]');
    let composerObservation;
    try {
      // QA-only metadata on the window, never on product state or DOM nodes.
      // Weak keys survive controller reconnects without retaining removed nodes;
      // a fresh scope/document is not evidence of a textarea replacement.
      const qa = window.__egdeskQaComposerObservationV1 ||= {
        scopeId: window.crypto?.randomUUID?.() || `${Date.now()}:${Math.random()}`,
        nodeIds: new WeakMap(), nextNodeId: 0,
      };
      const idOf = node => {
        if (!node) return null;
        if (!qa.nodeIds.has(node)) qa.nodeIds.set(node, ++qa.nextNodeId);
        return qa.nodeIds.get(node);
      };
      const short = value => String(value ?? '').slice(0, 160);
      composerObservation = {
        status: 'observed', scopeId: qa.scopeId, documentId: idOf(document),
        nodeId: idOf(input), rootNodeId: idOf(root), parentNodeId: idOf(input?.parentElement),
        connected: input?.isConnected ?? null, ownerDocumentMatches: input ? input.ownerDocument === document : null,
        wallTimeMs: Date.now(), monotonicMs: window.performance?.now?.() ?? null,
        timeOriginMs: window.performance?.timeOrigin ?? null,
        dimensions: input && { clientWidth: input.clientWidth, clientHeight: input.clientHeight,
          offsetWidth: input.offsetWidth, offsetHeight: input.offsetHeight,
          scrollWidth: input.scrollWidth, scrollHeight: input.scrollHeight,
          nativeScrollTopMax: inputBox.nativeScrollTopMax, rect: inputBox.rect },
        inlineStyle: input && Object.fromEntries(['height', 'minHeight', 'maxHeight', 'width']
          .map(key => [key, short(input.style?.[key])])),
        computedStyle: css && Object.fromEntries(['height', 'minHeight', 'maxHeight', 'width', 'boxSizing',
          'overflowX', 'overflowY', 'overflowAnchor', 'scrollBehavior', 'resize', 'whiteSpace', 'overflowWrap',
          'lineHeight', 'fontSize', 'paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth', 'transform']
          .map(key => [key, short(css[key])])),
      };
    } catch (error) {
      // Diagnostic availability must not change the native QA policy.
      composerObservation = { status: 'unavailable', error: String(error?.message || error).slice(0, 160) };
    }
    return { mode: codex?.chatDockMode, rootId: root?.id || null, cardId: codex?.chatCardEntityId || null,
      activeEntityId: state?.activeEntityId || null, threadId: thread?.id || null, inputThreadId: input?.dataset.threadId || null,
      inputCount: inputs.length, messagesCount: logs.length,
      messagesThreadId: messages?.dataset.threadId || null, conversationId: thread?.conversationId || null,
      messageCount: thread?.messages?.length ?? null, isSending: !!codex?.isSending, sendDisabled: send?.disabled ?? null,
      loggedIn: !!codex?.authStatus?.isLoggedIn, loginInProgress: !!(codex?.isStartingLogin || codex?.authStatus?.loginInProgress),
      accountBound: !!codex?.codexAccountKey, draft: codex?.threadDrafts?.[thread?.id] || '',
      camera: { zoom: state?.zoom, zoomTarget: state?.zoomTarget, pan: { ...state?.pan }, panTarget: { ...state?.panTarget } },
      viewport: { width: innerWidth, height: innerHeight },
      input: inputBox && { ...inputBox, value: input.value, focused: document.activeElement === input,
        selectionStart: input.selectionStart, selectionEnd: input.selectionEnd,
        lineHeight: px(css.lineHeight), contentHeight: input.clientHeight - px(css.paddingTop) - px(css.paddingBottom),
        fontPx: px(css.fontSize), projectedFontPx: px(css.fontSize) * (input.offsetWidth ? inputBox.rect.width / input.offsetWidth : 1) },
      composerObservation,
      messages: bounds(messages), login: { count: logins.length, text: login?.textContent.trim() || '',
        box: bounds(login), textFragments, missingTextRects } };
  });
}

// Compare individual existing poll returns, not just the final settled sample.
// This describes observed changes only: no setter tracing or inferred cause.
export function composerObservationChange(previous, current) {
  const before = previous?.composerObservation, after = current.composerObservation;
  const relation = after?.status !== 'observed' ? 'unavailable'
    : !previous ? 'first-observation' : before?.status !== 'observed' ? 'previous-unavailable'
    : before.scopeId !== after.scopeId ? 'identity-scope-reset'
    : before.documentId !== after.documentId || before.timeOriginMs !== after.timeOriginMs ? 'document-changed'
    : after.nodeId === null ? 'input-missing' : before.nodeId === null ? 'input-reappeared'
    : before.nodeId === after.nodeId ? 'same-node' : 'replacement';
  const sameNode = relation === 'same-node' ? true : relation === 'replacement' ? false : null;
  const a = previous?.value?.input, b = current.value?.input;
  const comparable = sameNode !== null && Number.isFinite(a?.scrollTop) && Number.isFinite(b?.scrollTop);
  const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  return { relation, sameNodeAsPrevious: sameNode, previousNodeId: before?.nodeId ?? null,
    previousScopeId: before?.scopeId ?? null,
    timeOriginChanged: Number.isFinite(before?.timeOriginMs) && Number.isFinite(after?.timeOriginMs)
      ? before.timeOriginMs !== after.timeOriginMs : null,
    scrollTopBefore: a?.scrollTop ?? null, scrollTopAfter: b?.scrollTop ?? null,
    scrollDelta: comparable ? b.scrollTop - a.scrollTop : null,
    scrollResetToZero: comparable ? a.scrollTop > 0 && 0 === b.scrollTop : null,
    sameNodeState: sameNode && a && b ? { valueUnchanged: a.value === b.value,
      draftUnchanged: previous.value.draft === current.value.draft,
      selectionUnchanged: a.selectionStart === b.selectionStart && a.selectionEnd === b.selectionEnd,
      focusUnchanged: a.focused === b.focused, dimensionsUnchanged: equal(before.dimensions, after.dimensions),
      inlineStyleUnchanged: equal(before.inlineStyle, after.inlineStyle),
      computedStyleUnchanged: equal(before.computedStyle, after.computedStyle),
      cameraUnchanged: equal(previous.value.camera, current.value.camera) } : null };
}

export function chatLoginReachable(value) {
  const login = value?.login, box = login?.box;
  return login?.count === 1 && login.text === '로그인' && box?.fullyVisible === true && box.hitCount === 9 && !box.disabled &&
    login.missingTextRects === 0 && login.textFragments.length > 0 &&
    login.textFragments.every(fragment => fragment.inside && fragment.hitCount === 3 && fragment.rect.width > 0 && fragment.rect.height > 0);
}

export function chatLastLineReachable(value, { caret = false } = {}) {
  const input = value?.input;
  return !!input && input.fullyVisible === true && input.hitCount === 9 && !input.disabled && !input.readOnly &&
    Number.isFinite(input.lineHeight) && input.lineHeight > 0 && input.contentHeight >= input.lineHeight &&
    Number.isFinite(input.projectedFontPx) && input.projectedFontPx >= 10.5 &&
    Number.isFinite(input.scrollTop) && input.scrollTop >= 0 && input.scrollHeight >= input.clientHeight &&
    Math.abs(input.scrollHeight - input.clientHeight - input.scrollTop) <= 1 &&
    (!caret || input.focused && input.selectionStart === input.value.length && input.selectionEnd === input.value.length);
}

export function assertChatReachabilityIdentity(before, after, draft = before?.draft) {
  assert.equal(before.mode, 'canvas'); assert.ok(before.threadId && before.rootId && before.cardId === before.rootId);
  assert.equal(before.inputThreadId, before.threadId); assert.equal(before.messagesThreadId, before.threadId);
  assert.equal(before.inputCount, 1); assert.equal(before.messagesCount, 1); assert.equal(before.sendDisabled, true);
  for (const key of ['mode', 'rootId', 'cardId', 'activeEntityId', 'threadId', 'inputThreadId', 'messagesThreadId',
    'inputCount', 'messagesCount', 'conversationId', 'messageCount', 'isSending', 'sendDisabled', 'loggedIn', 'loginInProgress', 'accountBound']) {
    assert.deepEqual(after[key], before[key], `native reachability changed ${key}`);
  }
  assert.deepEqual([after.messageCount, after.isSending, after.loggedIn, after.loginInProgress, after.accountBound], [0, false, false, false, false]);
  assert.deepEqual(after.camera, before.camera, 'inner scrolling must not pan/zoom the Canvas');
  assert.deepEqual(after.viewport, before.viewport);
  assert.equal(after.draft, draft); assert.equal(after.input.value, draft);
  assert.equal(after.input.fullyVisible, true); assert.equal(after.input.hitCount, 9);
  assert.equal(after.input.disabled, false); assert.equal(after.input.readOnly, false);
  return true;
}

export function nextChatReachabilityWheel(value, region, direction) {
  assert.ok(['messages', 'input'].includes(region) && [-1, 1].includes(direction));
  const box = value?.[region], max = box?.scrollHeight - box?.clientHeight;
  assert.ok(box?.shown && box.wheelPoint && Number.isFinite(max) && max >= 0, 'no observed owned wheel point');
  assert.ok(Number.isFinite(box.scrollTop) && box.scrollTop >= 0 && box.scrollTop <= max + 1);
  assert.ok(['x', 'y'].every(key => Number.isSafeInteger(box.wheelPoint[key]) && box.wheelPoint[key] >= 0));
  const remaining = direction < 0 ? box.scrollTop : max - box.scrollTop;
  if (remaining <= 1) return null; // Never wheel at an exhausted inner boundary.
  return { ...box.wheelPoint, deltaX: 0, deltaY: direction * Math.min(80, Math.ceil(remaining)) };
}

export function chatDocumentEndKey(platform = process.platform) {
  return platform === 'darwin' ? 'meta+ArrowDown' : 'Control+End';
}

export function nextChatLoginWheel(value) {
  const box = value?.login?.box, scale = value?.messages?.scaleY;
  assert.ok(box?.rect && box.clip && Number.isFinite(scale) && scale > 0, 'login scroll geometry missing');
  if (box.rect.height > box.clip.bottom - box.clip.top + 0.5) return null;
  const offset = box.rect.top < box.clip.top - 0.5 ? box.rect.top - box.clip.top
    : box.rect.bottom > box.clip.bottom + 0.5 ? box.rect.bottom - box.clip.bottom : 0;
  if (!offset) return null; // Occlusion/text clipping is not permission for blind scrolling.
  const step = nextChatReachabilityWheel(value, 'messages', Math.sign(offset));
  return step && { ...step, deltaY: Math.sign(offset) * Math.min(Math.abs(step.deltaY), Math.ceil(Math.abs(offset) / scale)) };
}

export async function verifyNarrowChatReachability(harness, size, deadlineMs, result, {
  read = observeChatReachability, now = Date.now, pause = sleep,
  capture = captureHeadlessScreenshot, platform = process.platform,
} = {}) {
  assert.ok(size.height === 600 && [600, 800].includes(size.width));
  const proof = { size, platform, endKey: chatDocumentEndKey(platform), observations: [], actions: [], captures: [],
    visualPass: null, lastLineRasterReview: 'pending-first-person-review', initialClipping: null,
    phase: 'after all original viewport assertions and captures; native Dock focus before this witness' };
  (result.narrowChatReachability ||= []).push(proof);
  let baseline = null, expectedDraft = DRAFT, transitionDraft = null;
  const sample = async label => {
    assertBeforeDeadline(deadlineMs, now());
    const { composerObservation, ...value } = await read(harness);
    const observation = { label, value };
    if (composerObservation) observation.composerObservation = { ...composerObservation,
      change: composerObservationChange(proof.observations.at(-1), { value, composerObservation }) };
    // Keep diagnostic IDs/timestamps/styles out of the existing settlement
    // signature and assertions. No extra reads, waits, actions or retries.
    proof.observations.push(observation);
    if (proof.observations.length > 200) throw new Error('Bounded Chat reachability observation limit');
    assertBeforeDeadline(deadlineMs, now());
    if (baseline) assertChatReachabilityIdentity(baseline, value,
      transitionDraft !== null && value.draft === transitionDraft ? transitionDraft : expectedDraft);
    return value;
  };
  const settle = async label => {
    let previous, same = 0, last;
    for (let i = 0; i < 30; i++) {
      last = await sample(label);
      const signature = JSON.stringify(last);
      same = signature === previous && last.draft === expectedDraft ? same + 1 : 0; previous = signature;
      if (same >= 2) { transitionDraft = null; return last; }
      await pause(120);
    }
    throw new Error(`Chat reachability did not settle: ${label}; input=${JSON.stringify(last?.input)}; login=${JSON.stringify(last?.login)}`);
  };
  const shot = async label => {
    const image = await capture(harness, `${size.width}x${size.height}-${label}`, deadlineMs, now);
    proof.captures.push(image); assert.equal(image.status, 'captured', 'reachability requires an actual image');
    return image;
  };
  const action = async (kind, input) => {
    assertBeforeDeadline(deadlineMs, now());
    const row = { kind, input, at: now(), dispatched: false }; proof.actions.push(row);
    // No retries after ambiguous input. Native login/send input is absent.
    row.dispatched = true;
    if (kind === 'wheel') await harness.wheelAt(input);
    else if (kind === 'composer-point-click') await harness.clickPoint(input);
    else if (kind === 'key') {
      assert.ok([proof.endKey, 'Backspace'].includes(input)); await harness.press(input);
    } else if (kind === 'append') { assert.equal(input, NARROW_CHAT_SAMPLE); await harness.typeText(input); }
    else throw new Error('Unsupported Chat reachability action');
    assertBeforeDeadline(deadlineMs, now());
  };
  const wheelTo = async (region, direction, accept, label) => {
    let value = await settle(`${label}:before`);
    for (let count = 0; !accept(value) && count < NARROW_CHAT_WHEEL_LIMIT; count++) {
      const input = region === 'messages' ? nextChatLoginWheel(value) : nextChatReachabilityWheel(value, region, direction);
      if (!input) break;
      const top = value[region].scrollTop;
      await action('wheel', input); value = await settle(`${label}:after-${count + 1}`);
      assert.ok(Math.sign(input.deltaY) * (value[region].scrollTop - top) > 0.5, `${label}: wheel must move the owned inner scroller`);
    }
    requireCheck(result, `${size.width}x${size.height}: ${label}`, accept(value), value);
    return value;
  };
  try {
    baseline = await settle('initial');
    assert.equal(baseline.draft, DRAFT); assertChatReachabilityIdentity(baseline, baseline);
    proof.initial = baseline;
    proof.initialClipping = { loginFullyVisible: chatLoginReachable(baseline), lastLineViewportAvailable: chatLastLineReachable(baseline),
      inputScrollTop: baseline.input.scrollTop, inputScrollHeight: baseline.input.scrollHeight, inputClientHeight: baseline.input.clientHeight };
    await shot('chat-initial-clipping'); // Initial clipping is evidence, not an invented readability pass.
    proof.loginReached = await wheelTo('messages', -1, chatLoginReachable, 'login full text and 9/9 hit reachable without clicking');
    await shot('chat-login-reachable');
    // Exercise internal input scrolling only when there is real scroll range.
    if (baseline.input.scrollHeight - baseline.input.clientHeight > 1) {
      await wheelTo('input', -1, value => value.input.scrollTop <= 1, 'composer start reachable by native wheel');
    }
    proof.lastLineReached = await wheelTo('input', 1, chatLastLineReachable, 'composer last-line viewport reachable by native wheel');
    const beforeClick = await sample('composer-point-preflight');
    assert.ok(beforeClick.input.wheelPoint && beforeClick.input.hitCount === 9 && beforeClick.input.fullyVisible);
    await action('composer-point-click', beforeClick.input.wheelPoint);
    assert.equal((await settle('composer-focused')).input.focused, true);
    await action('key', proof.endKey);
    proof.caretReached = await settle('composer-document-end');
    requireCheck(result, `${size.width}x${size.height}: native caret reaches complete draft end`, chatLastLineReachable(proof.caretReached, { caret: true }), proof.caretReached.input);
    await shot('chat-last-line-caret');
    if (size.width === 600) {
      // Explicit temporary edit; only the known appended suffix is removed.
      transitionDraft = expectedDraft; expectedDraft = DRAFT + NARROW_CHAT_SAMPLE;
      await action('append', NARROW_CHAT_SAMPLE);
      proof.appended = await settle('600-native-sample-appended');
      requireCheck(result, '600x600: native suffix and caret read back before explicit last-line review',
        proof.appended.input.focused && proof.appended.input.selectionStart === expectedDraft.length &&
        proof.appended.input.selectionEnd === expectedDraft.length, proof.appended.input);
      await shot('chat-native-sample-before-reveal');
      // Native caret exposure need not scroll all bottom padding into view.
      // Preserve that observation; explicitly review the new overflow once via
      // measured wheel steps. Never type the sample or move the caret again.
      proof.appendedReached = await wheelTo('input', 1, value => chatLastLineReachable(value, { caret: true }),
        'appended last-line viewport and caret reachable by native wheel');
      requireCheck(result, '600x600: native appended sample preserved at caret end without send',
        chatLastLineReachable(proof.appendedReached, { caret: true }), proof.appendedReached.input);
      await shot('chat-native-sample-appended');
      for (let remaining = NARROW_CHAT_SAMPLE.length; remaining > 0; remaining--) {
        const before = await sample('suffix-removal-preflight');
        assert.ok(chatLastLineReachable(before, { caret: true }));
        assert.equal(before.input.value, DRAFT + NARROW_CHAT_SAMPLE.slice(0, remaining));
        transitionDraft = expectedDraft; expectedDraft = DRAFT + NARROW_CHAT_SAMPLE.slice(0, remaining - 1);
        await action('key', 'Backspace');
        const removed = await settle('remove-one-owned-suffix-character');
        if (!chatLastLineReachable(removed, { caret: true })) {
          await wheelTo('input', 1, value => chatLastLineReachable(value, { caret: true }),
            `remaining owned suffix ${remaining - 1}: explicit last-line review`);
        }
      }
    }
    proof.restored = await settle('original-draft-restored');
    requireCheck(result, `${size.width}x${size.height}: original draft/thread/camera/send/auth state preserved after reachability`,
      assertChatReachabilityIdentity(baseline, proof.restored, DRAFT) && chatLastLineReachable(proof.restored, { caret: true }));
    proof.verified = true;
    return proof;
  } catch (error) {
    proof.error = error.message; proof.verified = false;
    try { if (now() < deadlineMs) await shot('chat-reachability-failure'); } catch (captureError) { proof.captureError = captureError.message; }
    throw error;
  }
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
  const create = dock.find(item => item.id === 'create');
  record(result, `${stage}: 새 카드 names itself and the menu it opens`,
    !!create && create.ariaLabel.startsWith('새 카드') && create.title.startsWith('새 카드'),
    { ariaLabel: create?.ariaLabel, title: create?.title });
  return { dock, zoom };
}

// Fixture-only readback for an existing Board project File. The card's actual
// header must be painted and hit-testable; a semantic proxy or active ID alone
// is not evidence that the File Card is visible.
export async function observeIdeProjectCard(harness, cardId) {
  return chrome(harness, ({ cardId: id }) => {
    const state = window.__egdesk?.state;
    const projection = state?.boards?.projections?.[state?.boards?.activeProjectionId];
    const card = document.getElementById(id), title = card?.querySelector('.egd-file-card-title');
    const editor = card?.querySelector('.egdesk-file-editor');
    const rect = title?.getBoundingClientRect();
    const viewport = document.getElementById('egd-canvas-viewport')?.getBoundingClientRect();
    const inside = !!rect && !!viewport && rect.width > 0 && rect.height > 0 &&
      rect.left >= Math.max(0, viewport.left) && rect.top >= Math.max(0, viewport.top) &&
      rect.right <= Math.min(innerWidth, viewport.right) && rect.bottom <= Math.min(innerHeight, viewport.bottom);
    let shown = !!card?.isConnected && !!title && !title.closest('[hidden], [inert], [aria-hidden="true"]');
    for (let node = title; shown && node; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) <= 0) shown = false;
    }
    let hits = 0;
    if (inside && shown) for (const fy of [0.2, 0.5, 0.8]) for (const fx of [0.2, 0.5, 0.8]) {
      const hit = document.elementFromPoint(rect.left + rect.width * fx, rect.top + rect.height * fy);
      if (hit && (hit === title || title.contains(hit))) hits++;
    }
    return { cardId: card?.id || null, boardId: projection?.boardId || null,
      reference: card?._fileRecord?.project || null, snapshot: card?._fileView?.snapshot() || null,
      activeEntityId: state?.activeEntityId || null, fileCount: document.querySelectorAll('.egd-file-card').length,
      terminalCount: document.querySelectorAll('.egd-terminal-card').length,
      editor: editor ? { value: editor.value, start: editor.selectionStart, end: editor.selectionEnd } : null,
      title: { inside, shown, hits, rect: rect && { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom } } };
  }, { cardId });
}

// The caller supplies the existing isolated project-file fixture's read-only
// state reader. Setup (including moving the already-connected Card offscreen)
// remains with that fixture; this path issues exactly one native Dock click.
export async function verifyIdeProjectCardVisible({ harness, size, deadlineMs, result, expected, readFixtureState }) {
  assertBeforeDeadline(deadlineMs);
  assertQaFixtureManifest(harness.profile);
  const guard = await observeGuard(harness);
  requireCheck(result, 'IDE visibility: owned headless Desk without an account',
    guard.documentURI === 'chrome://browser/content/browser.xhtml' && guard.headless && guard.mounted && !guard.loggedIn && !guard.accountBound);
  assert.equal(typeof readFixtureState, 'function', 'an isolated project fixture state reader is required');
  assert.ok(expected?.cardId && expected.boardId && expected.projectId && expected.rootId, 'exact fixture identity required');
  const storeBefore = await readFixtureState();
  result.ideEvidenceBoundary = {
    providerAndNativeProcess: 'fixture metadata only; not whole-process or provider-call instrumentation',
    terminal: 'only observed fixture terminal spawn/write routes are checked',
  };
  requireCheck(result, 'IDE visibility: owned synthetic fixture and declared structural metadata',
    storeBefore?.kind === 'egdesk-project-file-fixture' && storeBefore.fixture === true &&
    storeBefore.providerTurns === 0 && storeBefore.nativePickerInvocations === 0 && storeBefore.nativeProcessSpawns === 0);
  const before = await observeIdeProjectCard(harness, expected.cardId);
  const matches = value => value.cardId === expected.cardId && value.boardId === expected.boardId &&
    value.reference?.boardId === expected.boardId && value.reference?.projectId === expected.projectId &&
    value.snapshot?.projectId === expected.projectId && value.snapshot?.rootId === expected.rootId;
  requireCheck(result, 'IDE visibility: exact connected fixture card starts offscreen or obscured',
    matches(before) && !(before.title.shown && before.title.inside && before.title.hits === 9), before);
  await safeClick(harness, '#egd-dock .egd-dock-btn[data-id="create"]', 'IDE visibility: open the 새 카드 menu', size, deadlineMs, result);
  await safeClick(harness, '#egd-dock-menu .egd-dock-menu-item[data-id="ide"]', 'IDE visibility: native 새 카드 menu click', size, deadlineMs, result);
  const after = await waitFor(harness, value => observeIdeProjectCard(value, expected.cardId),
    value => matches(value) && value.activeEntityId === expected.cardId && value.title.shown &&
      value.title.inside && value.title.hits === 9, deadlineMs);
  const storeAfter = await readFixtureState();
  const addedFiles = storeAfter.fileRequests.slice(storeBefore.fileRequests.length);
  const addedTerminals = storeAfter.terminalRequests.slice(storeBefore.terminalRequests.length);
  const projectRead = addedFiles.find(request => request.operation === 'openProject' && request.status === 200 && request.response?.ok === true);
  const response = projectRead?.response?.result;
  const forbidden = new Set(['attachProject', 'registerRoot', 'beginPicker', 'completePicker', 'updateDraft',
    'saveDraft', 'saveOriginal', 'saveAs', 'setProjectScripts', 'suggestProjectScripts']);
  requireCheck(result, 'IDE visibility: same File and working copy; no recorded fixture picker, attach, terminal spawn or write',
    after.fileCount === before.fileCount && after.terminalCount === before.terminalCount &&
    JSON.stringify(after.snapshot) === JSON.stringify(before.snapshot) &&
    JSON.stringify(after.editor) === JSON.stringify(before.editor) &&
    projectRead?.request?.boardId === expected.boardId && response?.source === 'board' &&
    response.project?.source === 'board' && response.project.status === 'connected' &&
    response.project.projectId === expected.projectId && response.project.rootId === expected.rootId &&
    typeof response.project.directoryId === 'string' && !!response.project.directoryId &&
    !addedFiles.some(request => forbidden.has(request.operation)) &&
    !addedTerminals.some(request => ['/terminal/spawn', '/terminal/write'].includes(request.route)) &&
    storeAfter.currentOriginalSha256 === storeBefore.currentOriginalSha256 &&
    storeAfter.providerTurns === 0 && storeAfter.nativePickerInvocations === 0 && storeAfter.nativeProcessSpawns === 0,
    { before, after, projectResponse: response, addedOperations: addedFiles.map(request => request.operation) });
  return { before, after, projectResponse: response };
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
  await safeClick(harness, `${canvasSelector} button[title="오른쪽 패널로 옮기기"]`,
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
  // Complete the original four-size baseline (including all its captures)
  // before changing inner scroll/focus or temporarily appending native text.
  result.baselineChecksBeforeReachability = result.checks.length;
  for (const size of viewports.filter(size => size.height === 600 && [600, 800].includes(size.width))) {
    await resizeHeadless(harness, size, deadlineMs);
    await waitStableViewport(harness, size, deadlineMs);
    await focusChatDockForReachability(harness, size, deadlineMs, result);
    await waitFor(harness, observeChat, value => chatIssues(value,
      { mode: 'canvas', threadId, draft: DRAFT, messageCount: 0 }).length === 0, deadlineMs);
    await verifyNarrowChatReachability(harness, size, deadlineMs, result);
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
