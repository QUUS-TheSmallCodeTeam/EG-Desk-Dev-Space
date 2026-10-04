#!/usr/bin/env node
// Attach-only geometry and existing native-drag acceptance for Main's
// unmaximized QA Firefox window. No remount, CSS injection, npx or provider.
import fs from 'node:fs';
import path from 'node:path';
import { assertQaFixtureManifest } from './egdesk-chat-qa-profile.mjs';
import { chrome, option, runUiFlow, visible } from './egdesk-qa-ui-flow.mjs';

const phase = option('--phase', 'before-drag');
if (!['before-drag', 'after-drag'].includes(phase)) throw new Error('--phase must be before-drag or after-drag');
const CHECKPOINT_KIND = 'egdesk-flush-topbar-native-drag-qa-v1';
const PROFILE_CSS = 'CSS/eg-desk-surface.uc.css';

function authoredDragRules(profile) {
  const file = path.join(profile, 'chrome', PROFILE_CSS);
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() ||
      (info.mode & 0o022) !== 0 ||
      fs.realpathSync.native(file) !== file) {
    throw new Error('Topbar QA requires the canonical guarded-profile CSS file');
  }
  const css = fs.readFileSync(file, 'utf8');
  const selectors = ['#egd-desk-rail', '#egd-window-controls', '.egd-rail-switcher',
    '.egd-rail-search', '.egd-rail-icon', '.egd-rail-avatar'];
  return Object.fromEntries(selectors.map(selector => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const block = css.match(new RegExp(`^${escaped}\\s*\\{([^}]+)\\}`, 'm'))?.[1] || '';
    const value = block.match(/(?:^|;)\s*-moz-window-dragging\s*:\s*(drag|no-drag)\s*(?:;|$)/)?.[1] || null;
    return [selector, value];
  }));
}

function checkpoint(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() ||
      (info.mode & 0o022) !== 0 || fs.realpathSync.native(file) !== file) {
    throw new Error('Topbar QA checkpoint must be a canonical user-owned regular file');
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function observe(harness) {
  return chrome(harness, () => {
    const rail = document.getElementById('egd-desk-rail');
    const search = rail?.querySelector('.egd-rail-search');
    const input = rail?.querySelector('.egd-rail-search-input');
    const controls = [...(rail?.querySelectorAll('button, input') || [])];
    const rect = rail?.getBoundingClientRect();
    const style = rail && getComputedStyle(rail);
    // Gecko's chrome-only property can apply while being absent from CSSOM.
    // Record both access forms for diagnostics, never as the drag verdict.
    const dragCssom = node => {
      if (!node) return null;
      const computed = getComputedStyle(node);
      return { property: computed.getPropertyValue('-moz-window-dragging').trim(),
        alias: typeof computed.MozWindowDragging === 'string' ? computed.MozWindowDragging.trim() : null };
    };
    const blockerSelector = '#egd-window-controls, .egd-rail-switcher, .egd-rail-search, .egd-rail-icon, .egd-rail-avatar, button, input, textarea, select, a, [role="button"], [contenteditable="true"]';
    const blockers = [...(rail?.querySelectorAll(blockerSelector) || [])]
      .map(node => node.getBoundingClientRect()).filter(box => box.width > 0 && box.height > 0);
    let blank = null;
    if (rect) {
      const y = rect.top + rect.height / 2;
      let bestScore = -Infinity;
      for (let x = rect.left + Math.max(48, rect.width * 0.32); x < rect.right - 24; x += 8) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || hit.closest('#egd-desk-rail') !== rail || hit.closest(blockerSelector)) continue;
        const clearance = Math.min(rect.width, ...blockers.map(box => Math.hypot(
          Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom))));
        if (clearance < 18) continue;
        const score = Math.min(clearance, 80) - Math.abs(x - (rect.left + rect.width * 0.72)) * 0.03;
        if (score <= bestScore) continue;
        bestScore = score;
        blank = { x: Math.round(x), y: Math.round(y), tag: hit.localName,
          clearance: Math.round(clearance) };
      }
    }
    const pan = window.__egdesk?.state?.panTarget;
    return { mode: window.__egdesk?.surface?.snapshot?.().mode || null,
      rect: rect && { left: rect.left, top: rect.top, right: rect.right,
        bottom: rect.bottom, width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      radius: style && { topLeft: style.borderTopLeftRadius, topRight: style.borderTopRightRadius },
      dragCssom: { rail: dragCssom(rail), search: dragCssom(search), input: dragCssom(input) },
      controlCount: controls.length,
      searchExists: !!input, searchFocused: document.activeElement === input,
      blank, windowPosition: { x: window.screenX, y: window.screenY },
      normalWindow: window.windowState === window.STATE_NORMAL && !window.fullScreen,
      pan: pan ? { x: pan.x, y: pan.y } : null,
      zoom: window.__egdesk?.state?.zoomTarget ?? null };
  });
}

await runUiFlow(`viewport-topbar-${phase}`, async ({ harness, check, capture, result }) => {
  result.providerTurn = 'not-run';
  const manifest = assertQaFixtureManifest(harness.profile);
  const file = path.join(manifest.root, 'topbar-native-drag-checkpoint.json');
  await visible(harness, '#egd-desk-rail');
  const initial = await observe(harness);
  check('main EG-Desk rail belongs to the live Desk, not Browser Card chrome',
    initial.mode === 'desk' && initial.rect?.height > 0 && initial.searchExists);
  check('main rail is flush with the top and both side edges, not a floating pill',
    Math.abs(initial.rect.top) <= 1 && Math.abs(initial.rect.left) <= 1
      && Math.abs(initial.rect.right - initial.viewport.width) <= 1
      && initial.radius.topLeft === '0px' && initial.radius.topRight === '0px',
    { rect: initial.rect, viewport: initial.viewport, radius: initial.radius });
  const declarations = authoredDragRules(harness.profile);
  check('guarded profile CSS declares a draggable rail and non-draggable controls',
    declarations['#egd-desk-rail'] === 'drag'
      && Object.entries(declarations).every(([selector, value]) =>
        selector === '#egd-desk-rail' || value === 'no-drag'),
    { declarations, cssomDiagnostic: initial.dragCssom });
  check('a safely separated noninteractive drag point exists in the center/right rail',
    !!initial.blank && initial.blank.clearance >= 18,
    { blank: initial.blank, controlCount: initial.controlCount });
  if (phase === 'before-drag') {
    check('native drag acceptance starts with an unmaximized Firefox window', initial.normalWindow);
    if (fs.existsSync(file)) throw new Error('Topbar QA checkpoint already exists; do not overwrite prior evidence');
    await harness.click('.egd-rail-search-input');
    const focused = await observe(harness);
    check('search input remains focusable without panning Canvas or obscuring the drag point',
      focused.searchFocused && focused.pan?.x === initial.pan?.x && focused.pan?.y === initial.pan?.y
        && Math.abs(focused.zoom - initial.zoom) < 0.001
        && Math.hypot(focused.windowPosition.x - initial.windowPosition.x,
          focused.windowPosition.y - initial.windowPosition.y) < 1
        && !!focused.blank);
    fs.writeFileSync(file, JSON.stringify({ kind: CHECKPOINT_KIND, profile: harness.profile,
      windowPosition: focused.windowPosition, pan: focused.pan, zoom: focused.zoom,
      profileCssSha256: result.profileSources[PROFILE_CSS], blank: focused.blank }), { flag: 'wx', mode: 0o600 });
    result.nativeActionForMain = `Drag the noninteractive main topbar background near (${focused.blank.x}, ${focused.blank.y}) in this unmaximized window; do not drag Canvas or a control. Then run --phase after-drag.`;
    await capture('flush-topbar-before-native-drag');
    return;
  }
  const before = checkpoint(file);
  check('after-drag evidence belongs to the same QA window/profile',
    before.kind === CHECKPOINT_KIND && before.profile === harness.profile && initial.normalWindow
      && before.profileCssSha256 === result.profileSources[PROFILE_CSS]);
  check('existing native topbar drag moved the OS window without panning or zooming Canvas',
    Math.hypot(initial.windowPosition.x - before.windowPosition.x,
      initial.windowPosition.y - before.windowPosition.y) >= 10
      && Math.abs(initial.pan.x - before.pan.x) < 0.5
      && Math.abs(initial.pan.y - before.pan.y) < 0.5
      && Math.abs(initial.zoom - before.zoom) < 0.001,
    { before: before.windowPosition, after: initial.windowPosition,
      canvasPanBefore: before.pan, canvasPanAfter: initial.pan });
  await capture('flush-topbar-after-native-drag');
  result.nativeWindowMoved = true;
});
