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
    const dragStyle = node => node ? getComputedStyle(node).getPropertyValue('-moz-window-dragging').trim() : null;
    const noninteractive = node => !node?.closest('button, input, textarea, select, a, [role="button"], [contenteditable="true"]');
    let blank = null;
    if (rect) {
      const y = rect.top + rect.height / 2;
      for (let x = rect.left + 16; x < rect.right - 16; x += 16) {
        const hit = document.elementFromPoint(x, y);
        if (hit && hit.closest('#egd-desk-rail') === rail && noninteractive(hit)
            && dragStyle(hit) !== 'no-drag') {
          blank = { x: Math.round(x), y: Math.round(y), tag: hit.localName };
          break;
        }
      }
    }
    const pan = window.__egdesk?.state?.panTarget;
    return { mode: window.__egdesk?.surface?.snapshot?.().mode || null,
      rect: rect && { left: rect.left, top: rect.top, right: rect.right,
        bottom: rect.bottom, width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
      radius: style && { topLeft: style.borderTopLeftRadius, topRight: style.borderTopRightRadius },
      dragStyle: dragStyle(rail), searchDragStyle: dragStyle(search), inputDragStyle: dragStyle(input),
      controlCount: controls.length, interactiveControlsNoDrag: controls.every(node =>
        dragStyle(node) === 'no-drag' || dragStyle(node.closest('.egd-rail-search, #egd-window-controls')) === 'no-drag'),
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
  check('existing blank-area native drag region remains and controls stay non-draggable',
    initial.dragStyle === 'drag' && !!initial.blank && initial.interactiveControlsNoDrag,
    { dragStyle: initial.dragStyle, blank: initial.blank,
      searchDragStyle: initial.searchDragStyle, inputDragStyle: initial.inputDragStyle,
      controlCount: initial.controlCount });
  if (phase === 'before-drag') {
    check('native drag acceptance starts with an unmaximized Firefox window', initial.normalWindow);
    if (fs.existsSync(file)) throw new Error('Topbar QA checkpoint already exists; do not overwrite prior evidence');
    await harness.click('.egd-rail-search-input');
    const focused = await observe(harness);
    check('search input remains focusable and does not pan the Canvas',
      focused.searchFocused && focused.pan?.x === initial.pan?.x && focused.pan?.y === initial.pan?.y);
    fs.writeFileSync(file, JSON.stringify({ kind: CHECKPOINT_KIND, profile: harness.profile,
      windowPosition: initial.windowPosition, pan: initial.pan, zoom: initial.zoom,
      blank: initial.blank }), { flag: 'wx', mode: 0o600 });
    result.nativeActionForMain = `Drag the noninteractive main topbar background near (${initial.blank.x}, ${initial.blank.y}) in this unmaximized window; do not drag Canvas or a control. Then run --phase after-drag.`;
    await capture('flush-topbar-before-native-drag');
    return;
  }
  const before = checkpoint(file);
  check('after-drag evidence belongs to the same QA window/profile',
    before.kind === CHECKPOINT_KIND && before.profile === harness.profile && initial.normalWindow);
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
