#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const SCREENSHOT_PATH = process.argv[2] || '/tmp/egdesk-sourceref-verify.png';

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

async function callTool(name, args = {}, timeoutMs = 15000) {
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
    clientInfo: { name: 'egdesk-firefox-mcp-sourceref-verify', version: '0.1.0' },
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

      let style = document.getElementById('egd-sourceref-live-style');
      if (!style) {
        style = document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
        style.id = 'egd-sourceref-live-style';
        document.documentElement.appendChild(style);
      }
      // firefox-devtools-mcp >= 0.7: 함수 문자열 16KB 상한 — CSS는 privileged
    // context에서 직접 로드 (IOUtils — sync XHR은 file://에 NetworkError)
    style.textContent = await IOUtils.readUTF8(${JSON.stringify(cssSourcePath)});

      window.__egdesk = undefined;
      const ServicesRef = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
      ServicesRef.scriptloader.loadSubScript(${JSON.stringify(jsSourceUrl)}, window, 'UTF-8');

      return {
        hasApi: !!window.__egdesk?.sourceRefs,
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
      return wait(150).then(() => {
        const api = window.__egdesk;
        const testUrl = 'https://example.com/egdesk-source-ref?case=focus';
        const first = api.cardRuntime.openUrl(testUrl, { openMode: 'focus-existing' });
        const second = api.cardRuntime.openUrl(testUrl, { openMode: 'focus-existing' });
        const third = api.cardRuntime.openBrowserCard(testUrl, { openMode: 'new' });
        const settingsFirst = api.cardRuntime.openSettingsCard();
        const settingsSecond = api.cardRuntime.openSettingsCard();
        const terminalFirst = api.cardRuntime.openTerminalCard();
        const terminalSecond = api.cardRuntime.openTerminalCard();
        return wait(500).then(() => {
          const cards = api.sourceRefs.listOpenCards();
          const browserKey = first.dataset.sourceKey;
          const settingsKey = settingsFirst.dataset.sourceKey;
          const terminalKeys = [terminalFirst.dataset.sourceKey, terminalSecond.dataset.sourceKey];
          return {
            firstBrowserId: first.id,
            secondBrowserId: second.id,
            thirdBrowserId: third.id,
            focusReusedBrowser: first.id === second.id,
            explicitNewCreatedBrowser: first.id !== third.id,
            browserSameSourceCount: cards.filter((card) => card.sourceKey === browserKey).length,
            settingsSingleton: settingsFirst.id === settingsSecond.id,
            settingsSameSourceCount: cards.filter((card) => card.sourceKey === settingsKey).length,
            terminalsDistinct: terminalFirst.id !== terminalSecond.id && terminalKeys[0] !== terminalKeys[1],
            terminalCount: cards.filter((card) => card.sourceRef?.kind === 'terminal-session').length,
            dirty: api.state.agenda.dirty,
            dirtyRevision: api.state.agenda.dirtyRevision,
            dirtyBadgeVisible: !document.querySelector('.egd-rail-dirty-badge')?.hidden,
            sourceKinds: cards.map((card) => card.sourceRef?.kind || ''),
            cards,
          };
        });
      });
    })()`,
  }, 30000));

  const check = parseToolJson(checkText);
  const failures = [];
  if (!check.focusReusedBrowser) failures.push('focus-existing browser');
  if (!check.explicitNewCreatedBrowser || check.browserSameSourceCount !== 2) failures.push('explicit new browser');
  if (!check.settingsSingleton || check.settingsSameSourceCount !== 1) failures.push('settings singleton');
  if (!check.terminalsDistinct || check.terminalCount !== 2) failures.push('terminal sessions');
  if (!check.dirty || !check.dirtyBadgeVisible || check.dirtyRevision < 1) failures.push('agenda dirty');
  if (failures.length) {
    throw new Error(`SourceRef verification failed (${failures.join(', ')}): ${JSON.stringify(check, null, 2)}`);
  }

  const screenshot = resultText(await callTool('screenshot_page', { saveTo: SCREENSHOT_PATH }, 30000));

  console.log(JSON.stringify({
    ok: true,
    contextId: contextMatch[1],
    screenshot: SCREENSHOT_PATH,
    remount,
    check,
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
