#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const SCREENSHOT_PATH = process.argv[2] || '/tmp/egdesk-agenda-persistence-verify.png';

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
  if (trimmed.startsWith('Error:')) throw new Error(trimmed);
  const jsonText = trimmed.startsWith('Result:')
    ? trimmed.slice('Result:'.length).trim()
    : trimmed;
  return JSON.parse(jsonText);
}

async function callTool(name, args = {}, timeoutMs = 15000) {
  return request('tools/call', { name, arguments: args }, timeoutMs);
}

function remountExpression(styleId) {
  return `(() => {
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

    let style = document.getElementById(${JSON.stringify(styleId)});
    if (!style) {
      style = document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
      style.id = ${JSON.stringify(styleId)};
      document.documentElement.appendChild(style);
    }
    style.textContent = ${JSON.stringify(cssText)};

    window.__egdesk = undefined;
    const ServicesRef = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
    ServicesRef.scriptloader.loadSubScript(${JSON.stringify(jsSourceUrl)}, window, 'UTF-8');

    return {
      hasApi: !!window.__egdesk?.agenda,
      hasRail: !!document.getElementById('egd-desk-rail'),
      restoredCards: document.querySelectorAll('.egd-canvas-card').length,
      hasSavedState: !!window.__egdesk?.state?.agenda?.hasSavedState,
    };
  })()`;
}

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'egdesk-firefox-mcp-agenda-persistence-verify', version: '0.1.0' },
  });
  notify('notifications/initialized');

  const contexts = await callTool('list_privileged_contexts');
  const contextText = resultText(contexts);
  const contextMatch = contextText.match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/);
  if (!contextMatch) {
    throw new Error(`Firefox chrome context not found.\n${contextText}`);
  }

  await callTool('select_privileged_context', { contextId: contextMatch[1] });

  const firstRemount = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: remountExpression('egd-agenda-persistence-live-style'),
  }, 30000)));
  if (!firstRemount.hasApi || !firstRemount.hasRail) {
    throw new Error(`Initial remount failed: ${JSON.stringify(firstRemount, null, 2)}`);
  }

  const saveText = resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const api = window.__egdesk;
      api.agenda.clearSavedState();
      document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape').forEach((node) => {
        try { if (typeof node._cleanup === 'function') node._cleanup(); } catch {}
        node.remove();
      });
      api.state.sourceRefs.cardsByKey = Object.create(null);
      api.state.agenda.dirty = false;
      api.state.agenda.dirtyReasons = [];
      const card = api.cardRuntime.openBrowserCard('https://example.com/egdesk-agenda-persist', { openMode: 'new' });
      card.style.left = '240px';
      card.style.top = '190px';
      card.style.width = '640px';
      card.style.height = '450px';
      api.agenda.markDirty('test-persist-layout', card);
      const snapshot = api.agenda.save();
      return wait(200).then(() => ({
        saved: !!snapshot,
        dirtyAfterSave: api.state.agenda.dirty,
        hasSavedState: api.state.agenda.hasSavedState,
        saveButtonHidden: !!document.querySelector('.egd-rail-save-btn')?.hidden,
        restoreButtonHidden: !!document.querySelector('.egd-rail-restore-btn')?.hidden,
        savedCards: snapshot?.cards?.length || 0,
        savedUri: snapshot?.cards?.[0]?.runtimeState?.uri || null,
        savedGeometry: snapshot?.cards?.[0]?.geometry || null,
      }));
    })()`,
  }, 30000));

  const saveCheck = parseToolJson(saveText);
  if (!saveCheck.saved || saveCheck.dirtyAfterSave || !saveCheck.hasSavedState || saveCheck.savedCards !== 1) {
    throw new Error(`Save verification failed: ${JSON.stringify(saveCheck, null, 2)}`);
  }

  const secondRemount = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: remountExpression('egd-agenda-persistence-live-style'),
  }, 30000)));
  if (!secondRemount.hasApi || !secondRemount.hasSavedState || secondRemount.restoredCards !== 1) {
    throw new Error(`Saved-state remount failed: ${JSON.stringify(secondRemount, null, 2)}`);
  }

  const restoreText = resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      const card = document.querySelector('.egd-browser-card');
      const restored = card ? {
        id: card.id,
        left: Math.round(parseFloat(card.style.left) || 0),
        top: Math.round(parseFloat(card.style.top) || 0),
        width: Math.round(parseFloat(card.style.width) || 0),
        height: Math.round(parseFloat(card.style.height) || 0),
        uri: card.querySelector('.egd-card-url')?.value || null,
        sourceKey: card.dataset.sourceKey || null,
      } : null;
      return {
        dirty: api.state.agenda.dirty,
        hasSavedState: api.state.agenda.hasSavedState,
        restoredCardCount: document.querySelectorAll('.egd-canvas-card').length,
        restored,
        dirtyBadgeVisible: !document.querySelector('.egd-rail-dirty-badge')?.hidden,
        saveButtonHidden: !!document.querySelector('.egd-rail-save-btn')?.hidden,
        restoreButtonHidden: !!document.querySelector('.egd-rail-restore-btn')?.hidden,
      };
    })()`,
  }, 30000));

  const restoreCheck = parseToolJson(restoreText);
  const failures = [];
  if (restoreCheck.dirty) failures.push('dirty should be clean after restore');
  if (!restoreCheck.hasSavedState) failures.push('saved state metadata');
  if (restoreCheck.restoredCardCount !== 1) failures.push('restored card count');
  if (restoreCheck.restored?.uri !== 'https://example.com/egdesk-agenda-persist') failures.push('restored uri');
  if (restoreCheck.restored?.left !== 240 || restoreCheck.restored?.top !== 190) failures.push('restored geometry');
  if (!restoreCheck.saveButtonHidden || restoreCheck.restoreButtonHidden) failures.push('rail save/restore buttons');
  if (failures.length) {
    throw new Error(`Restore verification failed (${failures.join(', ')}): ${JSON.stringify(restoreCheck, null, 2)}`);
  }

  const screenshot = resultText(await callTool('screenshot_page', { saveTo: SCREENSHOT_PATH }, 30000));

  const cleanupText = resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape').forEach((node) => {
        try { if (typeof node._cleanup === 'function') node._cleanup(); } catch {}
        node.remove();
      });
      api?.agenda?.clearSavedState?.();
      if (api?.state) {
        api.state.sourceRefs.cardsByKey = Object.create(null);
        api.state.activeEntityId = null;
        api.state.agenda.dirty = false;
        api.state.agenda.dirtyRevision = 0;
      }
      return {
        hasSavedState: !!api?.state?.agenda?.hasSavedState,
        cardCount: document.querySelectorAll('.egd-canvas-card').length,
        dirty: !!api?.state?.agenda?.dirty,
      };
    })()`,
  }, 30000));

  console.log(JSON.stringify({
    ok: true,
    contextId: contextMatch[1],
    screenshot: SCREENSHOT_PATH,
    firstRemount,
    saveCheck,
    secondRemount,
    restoreCheck,
    cleanup: parseToolJson(cleanupText),
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
