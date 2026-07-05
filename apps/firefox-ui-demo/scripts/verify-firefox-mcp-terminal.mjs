#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const SCREENSHOT_PATH = process.argv[2] || '/tmp/egdesk-terminal-verify.png';

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
      '#egd-agenda-switcher',
      '#egd-rail-search-results',
      '.egd-browser-menu',
    ].forEach((selector) => document.querySelectorAll(selector).forEach((node) => node.remove()));

    let style = document.getElementById(${JSON.stringify(styleId)});
    if (!style) {
      style = document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
      style.id = ${JSON.stringify(styleId)};
      document.documentElement.appendChild(style);
    }
    // CSS는 인라인하지 않고 privileged context에서 직접 읽는다
    // (firefox-devtools-mcp >= 0.7 함수 문자열 16KB 상한 대응)
    style.textContent = await IOUtils.readUTF8(${JSON.stringify(cssSourcePath)});

    window.__egdesk = undefined;
    const ServicesRef = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
    ServicesRef.scriptloader.loadSubScript(${JSON.stringify(jsSourceUrl)}, window, 'UTF-8');

    return {
      hasApi: !!window.__egdesk?.cardRuntime,
      hasRail: !!document.getElementById('egd-desk-rail'),
    };
  })()`;
}

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'egdesk-firefox-mcp-terminal-verify', version: '0.1.0' },
  });
  notify('notifications/initialized');

  const contexts = await callTool('list_privileged_contexts');
  const contextText = resultText(contexts);
  const contextMatch = contextText.match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/);
  if (!contextMatch) throw new Error(`Firefox chrome context not found.\n${contextText}`);
  await callTool('select_privileged_context', { contextId: contextMatch[1] });

  const remount = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: remountExpression('egd-terminal-live-style'),
  }, 30000)));
  if (!remount.hasApi || !remount.hasRail) {
    throw new Error(`Remount failed: ${JSON.stringify(remount, null, 2)}`);
  }

  const check = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (fn, timeout = 10000) => {
        const started = Date.now();
        while (Date.now() - started < timeout) {
          const value = fn();
          if (value) return value;
          await wait(100);
        }
        throw new Error('timeout');
      };
      const toPrintfEscapes = (text) => {
        const bytes = new TextEncoder().encode(text);
        return Array.from(bytes).map((byte) => '\\\\' + byte.toString(8).padStart(3, '0')).join('');
      };
      const countOccurrences = (text, marker) => {
        return String(text || '').split(marker).length - 1;
      };

      return wait(150).then(async () => {
        const api = window.__egdesk;
        const card = api.cardRuntime.openTerminalCard();
        const frame = card.querySelector('iframe');
        const terminalApi = await waitFor(() => {
          const candidate = frame?.contentWindow?.terminalAPI;
          return candidate?.isConnected?.() ? candidate : null;
        }, 12000);

        const asciiMarker = 'EGD_ASCII_ONCE_' + Date.now();
        const hangulMarker = 'EGD_HANGUL_한글검증_' + Date.now();
        await terminalApi.write("printf '" + toPrintfEscapes(asciiMarker + '\\n') + "'\\n");
        await waitFor(() => terminalApi.bufferText().includes(asciiMarker), 5000);
        await terminalApi.write("printf '" + toPrintfEscapes(hangulMarker + '\\n') + "'\\n");
        await waitFor(() => terminalApi.bufferText().includes(hangulMarker), 5000);

        const resizeResult = await terminalApi.resize(100, 30);
        const bufferText = terminalApi.bufferText();
        const ptyIdBeforeKill = terminalApi.ptyId;
        const killResult = await terminalApi.kill();
        await wait(150);

        const cleanupEntity = (node) => {
          try { if (typeof node._cleanup === 'function') node._cleanup(); } catch {}
          node.remove();
        };
        document.querySelectorAll('.egd-canvas-card').forEach(cleanupEntity);
        api.state.agenda.dirty = false;
        api.state.agenda.dirtyReasons = [];

        return {
          cardId: card.id,
          iframeSrc: frame?.getAttribute('src') || null,
          ptyId: ptyIdBeforeKill,
          connectedBeforeKill: true,
          connectedAfterKill: terminalApi.isConnected(),
          asciiMarker,
          asciiCount: countOccurrences(bufferText, asciiMarker),
          hangulMarker,
          hangulPresent: bufferText.includes(hangulMarker),
          resizeOk: !!resizeResult?.ok,
          killOk: !!killResult?.ok,
          dirtyAfterCleanup: api.state.agenda.dirty,
        };
      });
    })()`,
  }, 30000)));

  const failures = [];
  if (!check.ptyId) failures.push('pty id');
  if (!check.iframeSrc || !check.iframeSrc.includes('terminal.html')) failures.push('iframe load');
  if (check.asciiCount !== 1) failures.push(`ascii duplicate count=${check.asciiCount}`);
  if (!check.hangulPresent) failures.push('hangul output');
  if (!check.resizeOk) failures.push('resize');
  if (!check.killOk) failures.push('kill');
  if (check.connectedAfterKill) failures.push('kill disconnected state');
  if (failures.length) {
    throw new Error(`Terminal verification failed: ${failures.join(', ')}\n${JSON.stringify(check, null, 2)}`);
  }

  const screenshot = resultText(await callTool('screenshot_page', { saveTo: SCREENSHOT_PATH }));

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
