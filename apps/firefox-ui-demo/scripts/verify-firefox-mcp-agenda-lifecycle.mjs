#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const SCREENSHOT_PATH = process.argv[2] || '/tmp/egdesk-agenda-lifecycle-verify.png';

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

function request(method, params = {}, timeoutMs = 45000) {
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

async function callTool(name, args = {}, timeoutMs = 45000) {
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
      '#egd-agenda-close-guard',
      '#egd-agenda-switcher',
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
      hasSwitcherButton: !!document.querySelector('.egd-rail-switcher'),
    };
  })()`;
}

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'egdesk-firefox-mcp-agenda-lifecycle-verify', version: '0.1.0' },
  });
  notify('notifications/initialized');

  const contexts = await callTool('list_privileged_contexts');
  const contextText = resultText(contexts);
  const contextMatch = contextText.match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/);
  if (!contextMatch) throw new Error(`Firefox chrome context not found.\n${contextText}`);
  await callTool('select_privileged_context', { contextId: contextMatch[1] });

  const remount = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: remountExpression('egd-agenda-lifecycle-live-style'),
  }, 30000)));
  if (!remount.hasApi || !remount.hasRail || !remount.hasSwitcherButton) {
    throw new Error(`Remount failed: ${JSON.stringify(remount, null, 2)}`);
  }

  const lifecycle = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      api.agenda.clearSavedState();
      api.agenda.clearView();

      api.state.agenda.activeAgendaId = 'agenda-lifecycle-a';
      api.state.agenda.activeTitle = 'Lifecycle A';
      const card = api.cardRuntime.openBrowserCard('https://example.com/egdesk-lifecycle-a', { openMode: 'new' });
      card.style.left = '210px';
      card.style.top = '170px';
      api.agenda.markDirty('lifecycle-a', card);
      api.agenda.save();

      const renamed = api.agenda.rename('agenda-lifecycle-a', 'Renamed Lifecycle');
      const duplicateId = api.agenda.duplicate('agenda-lifecycle-a', {
        title: 'Lifecycle Copy',
        activate: true,
      });
      const afterDuplicateCard = document.querySelector('.egd-browser-card');
      const afterDuplicate = {
        duplicateId,
        activeId: api.state.agenda.activeAgendaId,
        activeTitle: api.state.agenda.activeTitle,
        uri: afterDuplicateCard?.querySelector('.egd-card-url')?.value || null,
        dirty: api.state.agenda.dirty,
        list: api.agenda.list().map((entry) => ({ id: entry.id, title: entry.title, current: entry.current })),
      };

      api.agenda.delete('agenda-lifecycle-a');
      const afterDeleteInactive = {
        hasOriginal: !!api.agenda.readStore().agendas['agenda-lifecycle-a'],
        titles: api.agenda.list().map((entry) => entry.title),
        activeTitle: api.state.agenda.activeTitle,
      };

      api.agenda.delete(duplicateId, { force: true });
      const afterDeleteActive = {
        activeId: api.state.agenda.activeAgendaId,
        activeTitle: api.state.agenda.activeTitle,
        cardCount: document.querySelectorAll('.egd-canvas-card').length,
        dirty: api.state.agenda.dirty,
        storeAgendaIds: Object.keys(api.agenda.readStore().agendas || {}),
        list: api.agenda.list().map((entry) => ({ id: entry.id, title: entry.title, current: entry.current, saved: entry.saved })),
      };

      api.agenda.toggleSwitcher();
      const rowActions = document.querySelectorAll('.egd-agenda-switch-row-action').length;

      return {
        renamed,
        afterDuplicate,
        afterDeleteInactive,
        afterDeleteActive,
        switcherOpen: !!document.getElementById('egd-agenda-switcher'),
        rowActions,
      };
    })()`,
  }, 30000)));

  const screenshot = resultText(await callTool('screenshot_page', { saveTo: SCREENSHOT_PATH }, 30000));

  const cleanup = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      api.agenda.clearSavedState();
      api.agenda.close({ force: true });
      return {
        dirty: api.state.agenda.dirty,
        hasSavedState: api.state.agenda.hasSavedState,
        cardCount: document.querySelectorAll('.egd-canvas-card').length,
      };
    })()`,
  }, 30000)));

  const failures = [];
  if (lifecycle.renamed !== 'Renamed Lifecycle') failures.push('rename result');
  if (!lifecycle.afterDuplicate.duplicateId || lifecycle.afterDuplicate.activeTitle !== 'Lifecycle Copy') failures.push('duplicate active title');
  if (lifecycle.afterDuplicate.uri !== 'https://example.com/egdesk-lifecycle-a') failures.push('duplicate restored uri');
  if (lifecycle.afterDeleteInactive.hasOriginal) failures.push('inactive delete');
  if (lifecycle.afterDeleteActive.cardCount !== 0 || lifecycle.afterDeleteActive.dirty) failures.push('active delete fallback');
  if (!lifecycle.switcherOpen || lifecycle.rowActions < 3) failures.push('switcher action buttons');
  if (cleanup.dirty || cleanup.hasSavedState || cleanup.cardCount !== 0) failures.push('cleanup');
  if (failures.length) {
    throw new Error(`Agenda lifecycle verification failed (${failures.join(', ')}): ${JSON.stringify({ lifecycle, cleanup }, null, 2)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    contextId: contextMatch[1],
    screenshot: SCREENSHOT_PATH,
    remount,
    lifecycle,
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
