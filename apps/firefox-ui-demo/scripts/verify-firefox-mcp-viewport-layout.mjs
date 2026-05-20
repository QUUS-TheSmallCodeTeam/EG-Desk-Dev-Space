#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const SCREENSHOT_PATH = process.argv[2] || '/tmp/egdesk-viewport-layout-final.png';

const jsSourcePath = fileURLToPath(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url));
const cssSourcePath = fileURLToPath(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url));
const jsSourceUrl = pathToFileURL(jsSourcePath).href;
const cssText = readFileSync(cssSourcePath, 'utf8');

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

function request(method, params = {}, timeoutMs = 15000) {
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
  if (trimmed.startsWith('Error:')) {
    throw new Error(trimmed);
  }
  const jsonText = trimmed.startsWith('Result:')
    ? trimmed.slice('Result:'.length).trim()
    : trimmed;
  return JSON.parse(jsonText);
}

async function callTool(name, args = {}, timeoutMs = 15000) {
  return request('tools/call', { name, arguments: args }, timeoutMs);
}

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'egdesk-firefox-mcp-viewport-layout-verify', version: '0.1.0' },
  });
  notify('notifications/initialized');

  const contexts = await callTool('list_privileged_contexts');
  const contextText = resultText(contexts);
  const contextMatch = contextText.match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/);
  if (!contextMatch) {
    throw new Error(`Firefox chrome context not found.\n${contextText}`);
  }

  await callTool('select_privileged_context', { contextId: contextMatch[1] });

  const remountText = resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const cleanupEntity = (node) => {
        try { if (typeof node._cleanup === 'function') node._cleanup(); } catch {}
        node.remove();
      };

      document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape').forEach(cleanupEntity);
      [
        '#egd-window-controls',
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

      let style = document.getElementById('egd-viewport-layout-live-style');
      if (!style) {
        style = document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
        style.id = 'egd-viewport-layout-live-style';
        document.documentElement.appendChild(style);
      }
      style.textContent = ${JSON.stringify(cssText)};

      window.__egdesk = undefined;
      const ServicesRef = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
      ServicesRef.scriptloader.loadSubScript(${JSON.stringify(jsSourceUrl)}, window, 'UTF-8');

      return {
        href: document.location.href,
        hasWindowControls: !!document.getElementById('egd-window-controls'),
        hasRail: !!document.getElementById('egd-desk-rail'),
        railName: document.querySelector('.egd-rail-agenda-name')?.textContent?.trim() || null,
        helperStatusExists: !!document.getElementById('egd-input-helper-status'),
      };
    })()`,
  }, 30000));

  const remount = parseToolJson(remountText);
  if (!remount.hasWindowControls || !remount.hasRail || remount.railName !== 'EG-Desk Agenda' || remount.helperStatusExists) {
    throw new Error(`Overlay remount failed: ${JSON.stringify(remount, null, 2)}`);
  }

  const checkText = resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const clickDock = (id) => {
        const button = document.querySelector('.egd-dock-btn[data-id="' + id + '"]');
        if (!button) throw new Error('missing dock button: ' + id);
        button.click();
      };
      const rectOf = (node) => {
        if (!node) return null;
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
      const safeViewportRect = () => {
        const margin = 10;
        let left = margin;
        let top = margin;
        let right = Math.max(left + 1, window.innerWidth - margin);
        let bottom = Math.max(top + 1, window.innerHeight - margin);
        const rail = document.getElementById('egd-desk-rail');
        const dock = document.getElementById('egd-dock');
        const bag = document.getElementById('egd-preset-bag');
        if (rail) top = Math.max(top, rail.getBoundingClientRect().bottom + margin);
        if (dock) bottom = Math.min(bottom, dock.getBoundingClientRect().top - margin);
        if (bag) left = Math.max(left, bag.getBoundingClientRect().right + margin);
        return { left, top, right, bottom, width: right - left, height: bottom - top };
      };

      return wait(250).then(() => {
        const minimapButton = Array.from(document.querySelectorAll('.egd-rail-icon')).find((node) => node.title === '미니맵');
        if (!minimapButton) throw new Error('missing minimap button');
        minimapButton.click();
        clickDock('terminal');
        return wait(600);
      }).then(() => {
        const card = document.querySelector('.egd-terminal-card');
        if (!card) throw new Error('terminal card did not spawn');
        window.__egdesk.cardRuntime.toggleFullscreen(card);
        return wait(200).then(() => card);
      }).then((card) => {
        const cardRect = rectOf(card);
        const safe = safeViewportRect();
        const windowControls = document.getElementById('egd-window-controls');
        const windowControlButtons = Array.from(windowControls?.querySelectorAll('.egd-window-control') || []);
        const tolerance = 3;
        const fitsSafeArea = cardRect.left >= safe.left - tolerance
          && cardRect.top >= safe.top - tolerance
          && cardRect.right <= safe.right + tolerance
          && cardRect.bottom <= safe.bottom + tolerance;
        return {
          railName: document.querySelector('.egd-rail-agenda-name')?.textContent?.trim() || null,
          railCardBadge: document.querySelector('.egd-rail-card-badge')?.textContent?.trim() || null,
          railCardBadgeHidden: !!document.querySelector('.egd-rail-card-badge')?.hidden,
          helperStatusExists: !!document.getElementById('egd-input-helper-status'),
          windowControlsRect: rectOf(document.getElementById('egd-window-controls')),
          windowControlCount: document.querySelectorAll('#egd-window-controls .egd-window-control').length,
          windowControlTitles: windowControlButtons.map((node) => node.title),
          windowControlColors: windowControlButtons.map((node) => getComputedStyle(node).backgroundColor),
          minimapOpen: !!document.getElementById('egd-desk-minimap'),
          minimapRows: document.querySelectorAll('#egd-desk-minimap .egd-minimap-row').length,
          hudHidden: !!document.getElementById('egd-hud')?.classList.contains('egd-hud-hidden'),
          cardFullscreenClass: card.classList.contains('egd-card-fullscreen'),
          cardRect,
          safe,
          railRect: rectOf(document.getElementById('egd-desk-rail')),
          dockRect: rectOf(document.getElementById('egd-dock')),
          bagRect: rectOf(document.getElementById('egd-preset-bag')),
          fitsSafeArea,
        };
      });
    })()`,
  }, 30000));

  const check = parseToolJson(checkText);
  const failures = [];
  if (check.railName !== 'EG-Desk Agenda') failures.push('rail label');
  if (check.windowControlCount !== 3) failures.push('window control count');
  if (!check.windowControlTitles.includes('창 닫기') || !check.windowControlTitles.includes('창 최소화') || !check.windowControlTitles.includes('창 전체화면 전환')) failures.push('window control titles');
  if (!check.windowControlColors?.includes('rgb(255, 96, 87)') || !check.windowControlColors?.includes('rgb(255, 189, 46)') || !check.windowControlColors?.includes('rgb(39, 201, 63)')) failures.push('window control colors');
  if (!check.windowControlsRect || check.windowControlsRect.left >= check.railRect.left) failures.push('window controls placement');
  if (check.railCardBadge !== 'Terminal · Maximized' || check.railCardBadgeHidden) failures.push('maximized badge');
  if (check.helperStatusExists) failures.push('helper status hidden');
  if (!check.minimapOpen) failures.push('minimap');
  if (check.minimapRows < 1) failures.push('minimap rows');
  if (!check.hudHidden) failures.push('hud hidden while maximized');
  if (!check.cardFullscreenClass) failures.push('card maximized class');
  if (!check.fitsSafeArea) failures.push('safe area fit');
  if (failures.length) {
    throw new Error(`Viewport layout verification failed (${failures.join(', ')}): ${JSON.stringify(check, null, 2)}`);
  }

  const screenshot = resultText(await callTool('screenshot_page', { saveTo: SCREENSHOT_PATH }, 30000));
  const cleanup = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape').forEach((node) => {
        try { if (typeof node._cleanup === 'function') node._cleanup(); } catch {}
        node.remove();
      });
      document.getElementById('egd-desk-minimap')?.remove();
      api.state.cardFullscreen = null;
      api.state.sourceRefs.cardsByKey = Object.create(null);
      api.state.activeEntityId = null;
      api.state.agenda.dirty = false;
      api.state.agenda.dirtyRevision = 0;
      document.getElementById('egd-hud')?.classList.remove('egd-hud-hidden');
      api.cardRuntime.syncFullscreenLayout();
      return {
        cardCount: document.querySelectorAll('.egd-canvas-card').length,
        shapeCount: document.querySelectorAll('.egd-canvas-shape').length,
        minimapOpen: !!document.getElementById('egd-desk-minimap'),
        hudHidden: !!document.getElementById('egd-hud')?.classList.contains('egd-hud-hidden'),
        dirty: api.state.agenda.dirty,
      };
    })()`,
  }, 30000)));
  if (cleanup.cardCount !== 0 || cleanup.shapeCount !== 0 || cleanup.minimapOpen || cleanup.hudHidden || cleanup.dirty) {
    throw new Error(`Cleanup failed: ${JSON.stringify(cleanup, null, 2)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    contextId: contextMatch[1],
    screenshot: SCREENSHOT_PATH,
    remount,
    check,
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
