#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const SCREENSHOT_PATH = process.argv[2] || '/tmp/egdesk-minimap-drag-verify.png';

const jsSourcePath = fileURLToPath(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url));
const cssSourcePath = fileURLToPath(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url));
const jsSourceUrl = pathToFileURL(jsSourcePath).href;
const cssText = readFileSync(cssSourcePath, 'utf8');
const liveExtraCss = `

/* Dev verification reload layer: override stale startup userChrome geometry. */
#egd-desk-rail { left: 20px !important; right: 20px !important; transform: none !important; width: auto !important; height: 44px !important; border-radius: 22px !important; padding: 0 14px !important; gap: 14px !important; }
#egd-window-controls { position: static !important; height: 24px !important; width: max-content !important; padding: 0 !important; }
#egd-dock { bottom: 14px !important; height: 48px !important; border-radius: 14px !important; gap: 14px !important; padding: 0 16px !important; }
#egd-preset-bag { width: 52px !important; height: auto !important; max-height: calc(100vh - 160px) !important; padding: 10px 7px !important; gap: 9px !important; }
#egd-desk-minimap { top: 70px !important; right: 72px !important; width: 246px !important; padding: 9px !important; border-radius: 12px !important; }
.egd-minimap-map { height: 104px !important; }
`;

const proc = spawn('npx', [
  '-y',
  MCP_PACKAGE,
  '--connectExisting',
  '--marionettePort',
  MARIONETTE_PORT,
  '--enablePrivilegedContext',
  '--enableScript',
], { stdio: ['pipe', 'pipe', 'pipe'] });

let nextId = 1;
let stdoutBuffer = '';
let stderrBuffer = '';
const pending = new Map();

proc.stdout.on('data', (chunk) => {
  stdoutBuffer += chunk.toString();
  let index;
  while ((index = stdoutBuffer.indexOf('\n')) >= 0) {
    const line = stdoutBuffer.slice(0, index).trim();
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    if (!line.startsWith('{')) continue;

    const message = JSON.parse(line);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    }
  }
});

proc.stderr.on('data', (chunk) => {
  stderrBuffer += chunk.toString();
});

proc.on('exit', (code, signal) => {
  for (const { reject } of pending.values()) {
    reject(new Error(`MCP server exited code=${code} signal=${signal}`));
  }
  pending.clear();
});

function request(method, params = {}, timeoutMs = 60000) {
  const id = nextId++;
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timeout waiting for ${method}`));
    }, timeoutMs);

    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

function notify(method, params = {}) {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function resultText(result) {
  return (result.content || []).map((item) => item.text || '').join('\n');
}

function parseToolJson(text) {
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('Error:')) throw new Error(trimmed);
  // firefox-devtools-mcp >= 0.7: result JSON is wrapped in a ```json fence
  const fenced = trimmed.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fenced) return JSON.parse(fenced[1]);
  const jsonText = trimmed.startsWith('Result:')
    ? trimmed.slice('Result:'.length).trim()
    : trimmed;
  return JSON.parse(jsonText);
}

async function callTool(name, args = {}, timeoutMs = 60000) {
  let toolArgs = args;
  // firefox-devtools-mcp >= 0.7: evaluate_privileged_script takes `function`
  // (callable string) instead of `expression`. Wrap legacy IIFE expressions.
  if (name === 'evaluate_privileged_script' && typeof toolArgs.expression === 'string') {
    toolArgs = { function: `() => (\n${toolArgs.expression}\n)` };
  }
  return request('tools/call', { name, arguments: toolArgs }, timeoutMs);
}

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'egdesk-firefox-mcp-minimap-drag-verify', version: '0.1.0' },
  }, 60000);
  notify('notifications/initialized');

  const contexts = await callTool('list_privileged_contexts');
  const contextText = resultText(contexts);
  const contextMatch = contextText.match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/);
  if (!contextMatch) {
    throw new Error(`Firefox chrome context not found.\n${contextText}`);
  }

  await callTool('select_privileged_context', { contextId: contextMatch[1] });

  const remountText = resultText(await callTool('evaluate_privileged_script', {
    expression: `(async () => {
      const cleanupEntity = (node) => {
        try { if (typeof node._cleanup === 'function') node._cleanup(); } catch {}
        node.remove();
      };
      document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape').forEach(cleanupEntity);
      [
        '#egd-desk-rail',
        '#egd-dock',
        '#egd-preset-bag',
        '#egd-hud',
        '#egd-canvas-viewport',
        '#egd-selection-marquee',
        '#egd-zoom-indicator',
        '#egd-input-helper-status',
        '#egd-desk-minimap',
      ].forEach((selector) => document.querySelectorAll(selector).forEach((node) => node.remove()));

      let style = document.getElementById('egd-minimap-drag-live-style');
      if (!style) {
        style = document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
        style.id = 'egd-minimap-drag-live-style';
        document.documentElement.appendChild(style);
      }
      // firefox-devtools-mcp >= 0.7: 16KB 상한 — 본 CSS는 IOUtils로 로드, 오버라이드만 인라인
      style.textContent = await IOUtils.readUTF8(${JSON.stringify(cssSourcePath)}) + ${JSON.stringify(liveExtraCss)};

      window.__egdesk = undefined;
      const ServicesRef = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
      ServicesRef.scriptloader.loadSubScript(${JSON.stringify(jsSourceUrl)}, window, 'UTF-8');

      return {
        hasApi: !!window.__egdesk?.cardRuntime,
        hasRail: !!document.getElementById('egd-desk-rail'),
      };
    })()`,
  }, 30000));

  const remount = parseToolJson(remountText);
  if (!remount.hasApi || !remount.hasRail) {
    throw new Error(`Overlay remount failed: ${JSON.stringify(remount, null, 2)}`);
  }

  const checkText = resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const dispatchMouse = (target, type, x, y) => {
        target.dispatchEvent(new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          clientX: x,
          clientY: y,
          button: 0,
          buttons: type === 'mouseup' ? 0 : 1,
          view: window,
        }));
      };
      const rectOf = (node) => {
        const rect = node.getBoundingClientRect();
        return {
          left: Math.round(rect.left),
          top: Math.round(rect.top),
          right: Math.round(rect.right),
          bottom: Math.round(rect.bottom),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        };
      };
      return wait(150).then(() => {
        const api = window.__egdesk;
        const first = api.cardRuntime.openBrowserCard('https://example.com/egdesk-minimap-a', { openMode: 'new' });
        const second = api.cardRuntime.openTerminalCard();
        second.style.left = (parseFloat(first.style.left) + 1040) + 'px';
        second.style.top = (parseFloat(first.style.top) + 520) + 'px';
        const minimapButton = Array.from(document.querySelectorAll('.egd-rail-icon')).find((node) => node.title === '미니맵');
        if (!minimapButton) throw new Error('missing minimap button');
        minimapButton.click();
        return wait(250);
      }).then(() => {
        const api = window.__egdesk;
        const map = document.querySelector('.egd-minimap-map');
        const viewport = document.querySelector('.egd-minimap-viewport');
        if (!map || !viewport) throw new Error('missing minimap map or viewport');
        const spreadSnapshot = api.minimap.snapshot();
        const beforePan = { ...api.state.panTarget };
        const beforeViewport = rectOf(viewport);
        const startX = beforeViewport.left + beforeViewport.width / 2;
        const startY = beforeViewport.top + beforeViewport.height / 2;
        dispatchMouse(viewport, 'mousedown', startX, startY);
        dispatchMouse(window, 'mousemove', startX + 34, startY + 22);
        dispatchMouse(window, 'mouseup', startX + 34, startY + 22);
        return wait(150).then(() => {
          const afterViewport = rectOf(document.querySelector('.egd-minimap-viewport'));
          const afterPan = { ...api.state.panTarget };
          const panDelta = {
            x: Math.round(afterPan.x - beforePan.x),
            y: Math.round(afterPan.y - beforePan.y),
          };
          api.state.setCanvasViewportTarget({ pan: afterPan, zoom: 0.5 }, { immediate: true });
          const zoomOutSnapshot = api.minimap.snapshot();
          api.state.setCanvasViewportTarget({ pan: api.state.panTarget, zoom: 2 }, { immediate: true });
          const zoomInSnapshot = api.minimap.snapshot();
          return {
            beforePan,
            afterPan,
            panDelta,
            dragged: Math.abs(panDelta.x) > 5 || Math.abs(panDelta.y) > 5,
            markerCount: document.querySelectorAll('.egd-minimap-entity').length,
            viewportBefore: beforeViewport,
            viewportAfter: afterViewport,
            dragClassCleared: !map.classList.contains('egd-minimap-dragging'),
            spreadSnapshot,
            zoomOutSnapshot,
            zoomInSnapshot,
            zoomBoxResponds: zoomOutSnapshot.viewportBoxRect.width > zoomInSnapshot.viewportBoxRect.width
              && zoomOutSnapshot.viewportBoxRect.height > zoomInSnapshot.viewportBoxRect.height,
            dynamicSize: spreadSnapshot.dimensions.mapWidth > 260
              && spreadSnapshot.dimensions.mapHeight > 130
              && spreadSnapshot.spreadRatio > 1,
          };
        });
      });
    })()`,
  }, 30000));

  const check = parseToolJson(checkText);
  const failures = [];
  if (!check.dragged) failures.push('pan target changed by minimap drag');
  if (check.markerCount < 2) failures.push('entity markers');
  if (!check.dragClassCleared) failures.push('drag class cleanup');
  if (!check.zoomBoxResponds) failures.push('viewport box zoom response');
  if (!check.dynamicSize) failures.push('dynamic sparsity sizing');
  if (failures.length) {
    throw new Error(`Minimap drag verification failed (${failures.join(', ')}): ${JSON.stringify(check, null, 2)}`);
  }

  // UX-02: each Board has a region on the minimap. Pressing the region or its
  // name moves the camera to that Board; a View that is not a member lying
  // over it makes the press offer '이 위치의 2개'.
  const boardCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const press = (x, y) => {
        const init = (buttons) => ({ bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons, view: window });
        document.querySelector('.egd-minimap-map').dispatchEvent(new MouseEvent('mousedown', init(1)));
        window.dispatchEvent(new MouseEvent('mouseup', init(0)));
      };
      const center = (node) => {
        const rect = node.getBoundingClientRect();
        return [rect.left + rect.width / 2, rect.top + rect.height / 2];
      };
      const api = window.__egdesk;
      const projection = api.agenda.restoreSnapshot({
        version: 1,
        savedAt: 1,
        agenda: { id: 'egdesk-minimap-board-verify', title: '미니맵 확인', memberCardIds: [], contextBindings: [] },
        cards: [],
        shapes: [{ id: 'egdesk-minimap-board-mark', type: 'rect', geometry: { x: 0, y: 0, width: 360, height: 220 }, runtimeState: {} }],
      });
      if (!projection?.id) throw new Error('Board did not open');
      const lookAway = () => {
        api.state.setCanvasViewportTarget({ pan: { x: api.state.panTarget.x - 6000, y: api.state.panTarget.y }, zoom: 1 }, { immediate: true });
        api.state.boards.activeProjectionId = null;
        api.minimap.refresh();
      };
      const boardOnScreen = () => {
        const region = document.getElementById(projection.id);
        const zoom = api.state.zoomTarget;
        const pan = api.state.panTarget;
        const left = parseFloat(region.style.left) * zoom + pan.x;
        const top = parseFloat(region.style.top) * zoom + pan.y;
        return left >= 0 && top >= 0 && left + parseFloat(region.style.width) * zoom <= window.innerWidth
          && top + parseFloat(region.style.height) * zoom <= window.innerHeight;
      };
      const boardSelector = '.egd-minimap-board[data-projection-id="' + projection.id + '"]';
      if (!document.getElementById('egd-desk-minimap')) api.minimap.toggle();
      lookAway();
      return wait(150).then(() => {
        const label = document.querySelector('[data-testid="minimap-board-go"][data-projection-id="' + projection.id + '"]');
        const boardNode = document.querySelector(boardSelector);
        if (!label || !boardNode) throw new Error('missing minimap Board region');
        const regionName = label.getAttribute('aria-label');
        const panBefore = { ...api.state.panTarget };
        press(...center(boardNode));
        const byRegion = {
          stackOpened: !!document.querySelector('[data-testid="minimap-stack"]'),
          cameraMoved: Math.abs(api.state.panTarget.x - panBefore.x) > 5,
          onScreen: boardOnScreen(),
          selected: api.state.boards.activeProjectionId === projection.id,
        };
        lookAway();
        return wait(150).then(() => {
          document.querySelector('[data-testid="minimap-board-go"][data-projection-id="' + projection.id + '"]').click();
          const byName = { onScreen: boardOnScreen(), selected: api.state.boards.activeProjectionId === projection.id };
          const member = document.getElementById(projection.members[0].viewId);
          const free = api.shapes.restore({ id: 'egdesk-minimap-free-mark', type: 'rect', runtimeState: {},
            geometry: { x: parseFloat(member.style.left) + 20, y: parseFloat(member.style.top) + 20, width: 160, height: 100 } });
          api.minimap.refresh();
          return wait(100).then(() => {
            press(...center(document.querySelector('.egd-minimap-entity[data-entity-id="' + free.id + '"]')));
            const stack = document.querySelector('[data-testid="minimap-stack"]');
            const rows = api.minimap.snapshot().stack;
            document.querySelector('[data-testid="minimap-stack-row"][data-kind="view"]')?.click();
            return wait(100).then(() => ({
              projectionId: projection.id,
              regionName,
              byRegion,
              byName,
              stackTitle: stack?.getAttribute('aria-label') || null,
              stackRows: rows.map((row) => row.kind + ':' + row.targetId),
              stackClosedAfterPick: !document.querySelector('[data-testid="minimap-stack"]'),
              pickedView: api.state.activeEntityId === free.id,
              freeId: free.id,
            }));
          });
        });
      });
    })()`,
  }, 30000)));
  const boardFailures = [];
  if (boardCheck.regionName !== '미니맵 확인 Board로 이동') boardFailures.push('Board region with its name');
  if (boardCheck.byRegion.stackOpened || !boardCheck.byRegion.cameraMoved || !boardCheck.byRegion.onScreen || !boardCheck.byRegion.selected) {
    boardFailures.push('pressing the Board region goes to the Board');
  }
  if (!boardCheck.byName.onScreen || !boardCheck.byName.selected) boardFailures.push('the Board name goes to the Board');
  if (boardCheck.stackTitle !== '이 위치의 2개'
    || boardCheck.stackRows.join(',') !== `board:${boardCheck.projectionId},view:${boardCheck.freeId}`) boardFailures.push('overlap list');
  if (!boardCheck.stackClosedAfterPick || !boardCheck.pickedView) boardFailures.push('overlap list pick');
  if (boardFailures.length) {
    throw new Error(`Minimap Board verification failed (${boardFailures.join(', ')}): ${JSON.stringify(boardCheck, null, 2)}`);
  }

  const screenshot = resultText(await callTool('screenshot_page', { saveTo: SCREENSHOT_PATH }, 30000));
  const cleanup = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      const boardProjectionId = ${JSON.stringify(boardCheck.projectionId)};
      delete api.state.boards.projections[boardProjectionId];
      if (api.state.boards.activeProjectionId === boardProjectionId) api.state.boards.activeProjectionId = null;
      document.getElementById(boardProjectionId)?.remove();
      document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape').forEach((node) => {
        try { if (typeof node._cleanup === 'function') node._cleanup(); } catch {}
        node.remove();
      });
      document.getElementById('egd-desk-minimap')?.remove();
      api.state.sourceRefs.cardsByKey = Object.create(null);
      api.state.activeEntityId = null;
      api.state.agenda.dirty = false;
      api.state.agenda.dirtyRevision = 0;
      return {
        cardCount: document.querySelectorAll('.egd-canvas-card').length,
        shapeCount: document.querySelectorAll('.egd-canvas-shape').length,
        minimapOpen: !!document.getElementById('egd-desk-minimap'),
        boardRegionLeft: !!document.getElementById(boardProjectionId) || !!api.state.boards.projections[boardProjectionId],
        dirty: api.state.agenda.dirty,
      };
    })()`,
  }, 30000)));
  if (cleanup.cardCount !== 0 || cleanup.shapeCount !== 0 || cleanup.minimapOpen || cleanup.boardRegionLeft || cleanup.dirty) {
    throw new Error(`Cleanup failed: ${JSON.stringify(cleanup, null, 2)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    contextId: contextMatch[1],
    screenshot: SCREENSHOT_PATH,
    remount,
    check,
    boardCheck,
    cleanup,
    screenshotResult: screenshot,
  }, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  if (stderrBuffer.trim()) {
    console.error('\n[MCP stderr]');
    console.error(stderrBuffer.trim());
  }
  process.exitCode = 1;
}).finally(() => {
  proc.stdin.end();
  setTimeout(() => proc.kill('SIGTERM'), 500);
});
