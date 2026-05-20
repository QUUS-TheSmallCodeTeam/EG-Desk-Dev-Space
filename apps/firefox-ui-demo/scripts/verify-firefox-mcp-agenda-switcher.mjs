#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const SCREENSHOT_PATH = process.argv[2] || '/tmp/egdesk-agenda-switcher-verify.png';

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
    clientInfo: { name: 'egdesk-firefox-mcp-agenda-switcher-verify', version: '0.1.0' },
  });
  notify('notifications/initialized');

  const contexts = await callTool('list_privileged_contexts');
  const contextText = resultText(contexts);
  const contextMatch = contextText.match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/);
  if (!contextMatch) throw new Error(`Firefox chrome context not found.\n${contextText}`);
  await callTool('select_privileged_context', { contextId: contextMatch[1] });

  const remount = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: remountExpression('egd-agenda-switcher-live-style'),
  }, 30000)));
  if (!remount.hasApi || !remount.hasRail || !remount.hasSwitcherButton) {
    throw new Error(`Remount failed: ${JSON.stringify(remount, null, 2)}`);
  }

  const setupCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      api.agenda.clearSavedState();
      api.agenda.clearView();

      api.state.agenda.activeAgendaId = 'agenda-alpha';
      api.state.agenda.activeTitle = 'Alpha Agenda';
      const alpha = api.cardRuntime.openBrowserCard('https://example.com/egdesk-agenda-alpha', { openMode: 'new' });
      alpha.style.left = '220px';
      alpha.style.top = '180px';
      api.agenda.markDirty('alpha-setup', alpha);
      api.agenda.save();

      api.agenda.create({ force: true });
      api.state.agenda.activeTitle = 'Beta Agenda';
      const beta = api.cardRuntime.openBrowserCard('https://example.com/egdesk-agenda-beta', { openMode: 'new' });
      beta.style.left = '320px';
      beta.style.top = '240px';
      api.agenda.markDirty('beta-setup', beta);
      api.agenda.save();

      api.agenda.toggleSwitcher();
      const rows = Array.from(document.querySelectorAll('.egd-agenda-switch-row')).map((row) => ({
        id: row.dataset.agendaId,
        text: row.textContent,
        current: row.classList.contains('egd-agenda-switch-row-current'),
      }));
      return {
        activeTitle: api.state.agenda.activeTitle,
        activeId: api.state.agenda.activeAgendaId,
        switcherOpen: !!document.getElementById('egd-agenda-switcher'),
        rows,
        storeAgendaIds: Object.keys(api.agenda.readStore().agendas || {}),
      };
    })()`,
  }, 30000)));

  const switchCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      document.querySelector('[data-agenda-id="agenda-alpha"]')?.click();
      const card = document.querySelector('.egd-browser-card');
      return {
        activeTitle: api.state.agenda.activeTitle,
        activeId: api.state.agenda.activeAgendaId,
        dirty: api.state.agenda.dirty,
        cardCount: document.querySelectorAll('.egd-canvas-card').length,
        uri: card?.querySelector('.egd-card-url')?.value || null,
        switcherOpen: !!document.getElementById('egd-agenda-switcher'),
      };
    })()`,
  }, 30000)));

  const guardCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      const card = document.querySelector('.egd-browser-card');
      api.agenda.markDirty('alpha-dirty-before-switch', card);
      api.agenda.toggleSwitcher();
      const betaId = api.agenda.list().find((entry) => entry.title === 'Beta Agenda')?.id;
      document.querySelector('[data-agenda-id="' + betaId + '"]')?.click();
      const guardOpen = !!document.getElementById('egd-agenda-close-guard');
      document.querySelector('[data-action="continue"]')?.click();
      return {
        betaId,
        guardOpen,
        stillAlpha: api.state.agenda.activeId === 'agenda-alpha' || api.state.agenda.activeAgendaId === 'agenda-alpha',
        dirty: api.state.agenda.dirty,
        guardAfterContinue: !!document.getElementById('egd-agenda-close-guard'),
      };
    })()`,
  }, 30000)));

  const discardSwitchCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      api.agenda.toggleSwitcher();
      const betaId = api.agenda.list().find((entry) => entry.title === 'Beta Agenda')?.id;
      document.querySelector('[data-agenda-id="' + betaId + '"]')?.click();
      document.querySelector('[data-action="discard"]')?.click();
      const card = document.querySelector('.egd-browser-card');
      return {
        activeTitle: api.state.agenda.activeTitle,
        activeId: api.state.agenda.activeAgendaId,
        dirty: api.state.agenda.dirty,
        uri: card?.querySelector('.egd-card-url')?.value || null,
        guardOpen: !!document.getElementById('egd-agenda-close-guard'),
      };
    })()`,
  }, 30000)));

  const visualCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      if (!document.getElementById('egd-agenda-switcher')) api.agenda.toggleSwitcher();
      return {
        switcherOpen: !!document.getElementById('egd-agenda-switcher'),
        rowCount: document.querySelectorAll('.egd-agenda-switch-row').length,
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
  if (!setupCheck.switcherOpen || setupCheck.rows.length < 2) failures.push('switcher rows');
  if (!setupCheck.storeAgendaIds.includes('agenda-alpha') || setupCheck.storeAgendaIds.length < 2) failures.push('store agenda ids');
  if (switchCheck.activeId !== 'agenda-alpha' || switchCheck.uri !== 'https://example.com/egdesk-agenda-alpha') failures.push('switch to alpha');
  if (!guardCheck.guardOpen || !guardCheck.stillAlpha || !guardCheck.dirty || guardCheck.guardAfterContinue) failures.push('dirty switch guard continue');
  if (discardSwitchCheck.activeTitle !== 'Beta Agenda' || discardSwitchCheck.uri !== 'https://example.com/egdesk-agenda-beta' || discardSwitchCheck.dirty) failures.push('dirty switch discard');
  if (!visualCheck.switcherOpen || visualCheck.rowCount < 2) failures.push('visual switcher state');
  if (cleanup.dirty || cleanup.hasSavedState || cleanup.cardCount !== 0) failures.push('cleanup');
  if (failures.length) {
    throw new Error(`Agenda switcher verification failed (${failures.join(', ')}): ${JSON.stringify({
      setupCheck,
      switchCheck,
      guardCheck,
      discardSwitchCheck,
      visualCheck,
      cleanup,
    }, null, 2)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    contextId: contextMatch[1],
    screenshot: SCREENSHOT_PATH,
    remount,
    setupCheck,
    switchCheck,
    guardCheck,
    discardSwitchCheck,
    visualCheck,
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
