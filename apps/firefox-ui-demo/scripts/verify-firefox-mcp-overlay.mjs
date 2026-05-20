#!/usr/bin/env node

import { spawn } from 'node:child_process';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const TARGET_BUTTON = process.argv[2] || '설정';
const SCREENSHOT_PATH = process.argv[3] || '/tmp/egdesk-mcp-overlay-verify.png';

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

async function callTool(name, args = {}) {
  return request('tools/call', { name, arguments: args });
}

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'egdesk-firefox-mcp-overlay-verify', version: '0.1.0' },
  });
  notify('notifications/initialized');

  const contexts = await callTool('list_privileged_contexts');
  const contextText = resultText(contexts);
  const contextMatch = contextText.match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/);
  if (!contextMatch) {
    throw new Error(`Firefox chrome context not found.\n${contextText}`);
  }

  const contextId = contextMatch[1];
  await callTool('select_privileged_context', { contextId });

  const before = resultText(await callTool('evaluate_privileged_script', {
    expression: '(function(){ return {href: document.location.href, hasRail: !!document.getElementById("egd-desk-rail"), hasDock: !!document.getElementById("egd-dock"), cardCount: document.querySelectorAll(".egd-canvas-card").length}; })()',
  }));

  const snapshot = await callTool('take_snapshot', {
    selector: '#egd-dock',
    maxLines: 160,
    includeAll: true,
  });
  const snapshotText = resultText(snapshot);
  const escapedTitle = TARGET_BUTTON.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const uidMatch = snapshotText.match(new RegExp(`uid=([^\\s]+) button "${escapedTitle}"`));
  if (!uidMatch) {
    throw new Error(`Dock button not found: ${TARGET_BUTTON}\n${snapshotText}`);
  }

  const uid = uidMatch[1];
  await callTool('click_by_uid', { uid });
  await new Promise((resolve) => setTimeout(resolve, 500));

  const after = resultText(await callTool('evaluate_privileged_script', {
    expression: '(function(){ return {cardCount: document.querySelectorAll(".egd-canvas-card").length, cards: Array.from(document.querySelectorAll(".egd-canvas-card")).map(c => ({id: c.id, className: c.className}))}; })()',
  }));

  const screenshot = resultText(await callTool('screenshot_page', { saveTo: SCREENSHOT_PATH }));

  console.log(JSON.stringify({
    ok: true,
    contextId,
    clicked: TARGET_BUTTON,
    screenshot: SCREENSHOT_PATH,
    before,
    after,
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
