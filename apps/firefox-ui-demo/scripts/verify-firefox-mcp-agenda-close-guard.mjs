#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const SCREENSHOT_PATH = process.argv[2] || '/tmp/egdesk-agenda-close-guard-verify.png';

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
  // firefox-devtools-mcp >= 0.7: result JSON is wrapped in a ```json fence
  const fenced = trimmed.match(/```json\s*\n([\s\S]*?)\n```/);
  if (fenced) return JSON.parse(fenced[1]);
  const jsonText = trimmed.startsWith('Result:')
    ? trimmed.slice('Result:'.length).trim()
    : trimmed;
  return JSON.parse(jsonText);
}

async function callTool(name, args = {}, timeoutMs = 45000) {
  let toolArgs = args;
  // firefox-devtools-mcp >= 0.7: evaluate_privileged_script takes `function`
  // (callable string) instead of `expression`. Wrap legacy IIFE expressions.
  if (name === 'evaluate_privileged_script' && typeof toolArgs.expression === 'string') {
    toolArgs = { function: `() => (\n${toolArgs.expression}\n)` };
  }
  return request('tools/call', { name, arguments: toolArgs }, timeoutMs);
}

function remountExpression(styleId) {
  return `(async () => {
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
      '#egd-agenda-close-guard',
    ].forEach((selector) => document.querySelectorAll(selector).forEach((node) => node.remove()));

    let style = document.getElementById(${JSON.stringify(styleId)});
    if (!style) {
      style = document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
      style.id = ${JSON.stringify(styleId)};
      document.documentElement.appendChild(style);
    }
    // firefox-devtools-mcp >= 0.7: 함수 문자열 16KB 상한 — CSS는 privileged
    // context에서 직접 로드 (IOUtils — sync XHR은 file://에 NetworkError)
    style.textContent = await IOUtils.readUTF8(${JSON.stringify(cssSourcePath)});

    window.__egdesk = undefined;
    const ServicesRef = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
    ServicesRef.scriptloader.loadSubScript(${JSON.stringify(jsSourceUrl)}, window, 'UTF-8');

    return {
      hasApi: !!window.__egdesk?.agenda,
      hasRail: !!document.getElementById('egd-desk-rail'),
      hasCloseButton: !!document.querySelector('.egd-rail-close-agenda-btn'),
    };
  })()`;
}

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'egdesk-firefox-mcp-agenda-close-guard-verify', version: '0.1.0' },
  }, 30000);
  notify('notifications/initialized');

  const contexts = await callTool('list_privileged_contexts');
  const contextText = resultText(contexts);
  const contextMatch = contextText.match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/);
  if (!contextMatch) {
    throw new Error(`Firefox chrome context not found.\n${contextText}`);
  }

  await callTool('select_privileged_context', { contextId: contextMatch[1] });

  const remount = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: remountExpression('egd-agenda-close-guard-live-style'),
  }, 30000)));
  if (!remount.hasApi || !remount.hasRail || !remount.hasCloseButton) {
    throw new Error(`Remount failed: ${JSON.stringify(remount, null, 2)}`);
  }

  const guardText = resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      api.agenda.clearSavedState();
      api.agenda.clearView();
      const card = api.cardRuntime.openBrowserCard('https://example.com/egdesk-close-guard', { openMode: 'new' });
      card.style.left = '180px';
      card.style.top = '160px';
      api.agenda.markDirty('test-close-guard', card);
      const closeResult = api.agenda.close();
      return {
        closeResult,
        guardOpen: !!document.getElementById('egd-agenda-close-guard'),
        closeGuardOpenState: !!api.state.agenda.closeGuardOpen,
        dirty: api.state.agenda.dirty,
        cardCount: document.querySelectorAll('.egd-canvas-card').length,
        primaryText: document.querySelector('[data-action="save"]')?.textContent || null,
        discardText: document.querySelector('[data-action="discard"]')?.textContent || null,
        continueText: document.querySelector('[data-action="continue"]')?.textContent || null,
      };
    })()`,
  }, 30000));
  const guardCheck = parseToolJson(guardText);

  const screenshot = resultText(await callTool('screenshot_page', { saveTo: SCREENSHOT_PATH }, 30000));

  const continueText = resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      document.querySelector('[data-action="continue"]')?.click();
      const api = window.__egdesk;
      return {
        guardOpen: !!document.getElementById('egd-agenda-close-guard'),
        closeGuardOpenState: !!api.state.agenda.closeGuardOpen,
        dirty: api.state.agenda.dirty,
        cardCount: document.querySelectorAll('.egd-canvas-card').length,
      };
    })()`,
  }, 30000));
  const continueCheck = parseToolJson(continueText);

  const discardText = resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      api.agenda.close();
      document.querySelector('[data-action="discard"]')?.click();
      return {
        guardOpen: !!document.getElementById('egd-agenda-close-guard'),
        closeGuardOpenState: !!api.state.agenda.closeGuardOpen,
        dirty: api.state.agenda.dirty,
        cardCount: document.querySelectorAll('.egd-canvas-card').length,
        hasSavedState: api.state.agenda.hasSavedState,
        restoreButtonHidden: !!document.querySelector('.egd-rail-restore-btn')?.hidden,
      };
    })()`,
  }, 30000));
  const discardCheck = parseToolJson(discardText);

  const saveCloseText = resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      const card = api.cardRuntime.openBrowserCard('https://example.com/egdesk-close-save', { openMode: 'new' });
      card.style.left = '260px';
      card.style.top = '210px';
      card.style.width = '620px';
      card.style.height = '420px';
      api.agenda.markDirty('test-close-save', card);
      api.agenda.close();
      document.querySelector('[data-action="save"]')?.click();
      const savedSnapshot = api.agenda.restore();
      const restoredCard = document.querySelector('.egd-browser-card');
      return {
        guardOpen: !!document.getElementById('egd-agenda-close-guard'),
        closeGuardOpenState: !!api.state.agenda.closeGuardOpen,
        dirty: api.state.agenda.dirty,
        cardCountAfterClose: document.querySelectorAll('.egd-canvas-card').length,
        hasSavedState: api.state.agenda.hasSavedState,
        restoreButtonHidden: !!document.querySelector('.egd-rail-restore-btn')?.hidden,
        saveButtonHidden: !!document.querySelector('.egd-rail-save-btn')?.hidden,
        restored: !!savedSnapshot,
        restoredUri: restoredCard?.querySelector('.egd-card-url')?.value || null,
        restoredLeft: Math.round(parseFloat(restoredCard?.style.left) || 0),
        restoredTop: Math.round(parseFloat(restoredCard?.style.top) || 0),
      };
    })()`,
  }, 30000));
  const saveCloseCheck = parseToolJson(saveCloseText);

  const cleanupText = resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      api.agenda.clearSavedState();
      api.agenda.close({ force: true });
      return {
        hasSavedState: !!api.state.agenda.hasSavedState,
        dirty: !!api.state.agenda.dirty,
        cardCount: document.querySelectorAll('.egd-canvas-card').length,
      };
    })()`,
  }, 30000));
  const cleanup = parseToolJson(cleanupText);

  const failures = [];
  if (guardCheck.closeResult !== false) failures.push('dirty close should be blocked by guard');
  if (!guardCheck.guardOpen || !guardCheck.closeGuardOpenState || !guardCheck.dirty || guardCheck.cardCount !== 1) failures.push('guard open state');
  if (guardCheck.primaryText !== '저장 후 닫기' || guardCheck.discardText !== '저장하지 않고 닫기' || guardCheck.continueText !== '취소') failures.push('guard button labels');
  if (continueCheck.guardOpen || continueCheck.closeGuardOpenState || !continueCheck.dirty || continueCheck.cardCount !== 1) failures.push('continue action');
  if (discardCheck.guardOpen || discardCheck.closeGuardOpenState || discardCheck.dirty || discardCheck.cardCount !== 0 || discardCheck.hasSavedState) failures.push('discard action');
  if (saveCloseCheck.guardOpen || saveCloseCheck.closeGuardOpenState || saveCloseCheck.dirty || !saveCloseCheck.hasSavedState) failures.push('save-close state');
  if (saveCloseCheck.restoredUri !== 'https://example.com/egdesk-close-save') failures.push('save-close restore uri');
  if (saveCloseCheck.restoredLeft !== 260 || saveCloseCheck.restoredTop !== 210) failures.push('save-close restore geometry');
  if (cleanup.hasSavedState || cleanup.dirty || cleanup.cardCount !== 0) failures.push('cleanup');
  if (failures.length) {
    throw new Error(`Agenda close guard verification failed (${failures.join(', ')}): ${JSON.stringify({
      guardCheck,
      continueCheck,
      discardCheck,
      saveCloseCheck,
      cleanup,
    }, null, 2)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    contextId: contextMatch[1],
    screenshot: SCREENSHOT_PATH,
    remount,
    guardCheck,
    continueCheck,
    discardCheck,
    saveCloseCheck,
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
