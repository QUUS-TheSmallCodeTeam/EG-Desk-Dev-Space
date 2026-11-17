#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { boundedFieldValue } from '../helper/egdesk-browser-tool-runtime.mjs';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const SCREENSHOT_PATH = process.argv[2] || '/tmp/egdesk-browser-agent-observation.png';

const jsSourcePath = fileURLToPath(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url));
const cssSourcePath = fileURLToPath(new URL('../overlay/CSS/eg-desk-surface.uc.css', import.meta.url));
const jsSourceUrl = 'chrome://userscripts/content/eg-desk-surface.uc.js';
const cssText = readFileSync(cssSourcePath, 'utf8');

// BRW-08 headless fixture cases (2026-11-17): a same-origin iframe, an open
// shadow root, a contenteditable editor and a field holding a long value sit
// beside the original reveal/fill page. The page is exported (with the checks
// below) so a node test can pin it without Firefox; main() runs only when
// this file is executed, never on import.
export const LONG_NOTE_VALUE = `${'Long note line. '.repeat(24)}end`;
export const frameHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>Embedded compose</title></head>
<body><button id="frame-send" type="button">Frame send</button>
<input id="frame-note" aria-label="Frame note"></body></html>`;
export const pageHtml = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Agent Observation Fixture</title>
    <style>
      body { font-family: system-ui, sans-serif; padding: 32px; }
      button, input { font: inherit; margin: 8px 0; padding: 8px 10px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Agent Observation Fixture</h1>
      <p id="intro">Initial content only</p>
      <label for="query">Search note</label>
      <input id="query" name="query" placeholder="Search note">
      <button id="reveal" type="button">Reveal details</button>
      <section id="details" aria-live="polite"></section>
      <section id="brw08">
        <iframe id="compose-frame" title="Compose" src="/agent-observation/frame" width="320" height="120"></iframe>
        <x-widget id="widget"></x-widget>
        <div id="editor" contenteditable="true" aria-label="Message body">Draft body</div>
        <label for="long-note">Long note</label>
        <textarea id="long-note" name="long-note" aria-label="Long note">${LONG_NOTE_VALUE}</textarea>
      </section>
    </main>
    <script>
      customElements.define('x-widget', class extends HTMLElement {
        connectedCallback() {
          if (this.shadowRoot) return;
          this.attachShadow({ mode: 'open' }).innerHTML = '<button type="button">Shadow save</button>';
        }
      });
      document.getElementById('reveal').addEventListener('click', () => {
        document.title = 'Agent Observation Updated';
        document.getElementById('details').innerHTML = '<p>Details ready for the agent</p><button id="continue" type="button">Continue</button>';
        document.getElementById('query').focus();
      });
    </script>
  </body>
</html>`;
let fixtureServer = null;
let pageUrl = '';

function startFixtureServer() {
  return new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      if (request.url === '/agent-observation/frame') {
        response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' });
        response.end(frameHtml);
        return;
      }
      if (request.url !== '/' && request.url !== '/agent-observation') {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Not found');
        return;
      }
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-type': 'text/html; charset=utf-8',
      });
      response.end(pageHtml);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      fixtureServer = server;
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}/agent-observation`);
    });
  });
}

let proc = null;
let nextId = 1;
let stdoutBuffer = '';
let stderrBuffer = '';
const pending = new Map();

function startMcp() {
proc = spawn('npx', [
  '-y',
  MCP_PACKAGE,
  '--connectExisting',
  '--marionettePort',
  MARIONETTE_PORT,
  '--enablePrivilegedContext',
  '--enableScript',
], { stdio: ['pipe', 'pipe', 'pipe'] });

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
}

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

let privilegedContext = null;

async function callTool(name, args = {}, timeoutMs = 45000) {
  let toolArgs = args;
  // firefox-devtools-mcp >= 0.7: evaluate_privileged_script takes `function`
  // (callable string) instead of `expression`. Wrap legacy IIFE expressions.
  if (name === 'evaluate_privileged_script' && typeof toolArgs.expression === 'string') {
    toolArgs = { context: privilegedContext, function: `() => (\n${toolArgs.expression}\n)` };
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
    // firefox-devtools-mcp >= 0.7: 함수 문자열 16KB 상한 — CSS는 privileged
    // context에서 직접 로드 (IOUtils — sync XHR은 file://에 NetworkError)
    style.textContent = await IOUtils.readUTF8(${JSON.stringify(cssSourcePath)});

    window.__egdesk = undefined;
    const ServicesRef = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
    ServicesRef.scriptloader.loadSubScript(${JSON.stringify(jsSourceUrl)}, window, 'UTF-8');

    return {
      hasApi: !!window.__egdesk?.browserAgent && !!window.__egdesk?.browserRuntime,
      hasRail: !!document.getElementById('egd-desk-rail'),
    };
  })()`;
}

/**
 * BRW-08 checks over the first observation of the fixture page: what the
 * privileged script reports as check.brw08. Returns the failed case names.
 */
export function brw08Failures(brw08) {
  const failures = [];
  const frame = brw08?.frameButton;
  if (!frame || !/^f\d+\/el_\d+$/.test(String(frame.ref || ''))) failures.push('iframe element ref with frame path');
  if (!brw08?.frameInput || !/^f\d+\//.test(String(brw08.frameInput.ref || ''))) failures.push('iframe field ref');
  if (!brw08?.shadowButton?.ref) failures.push('open shadow root element');
  const editor = brw08?.editor;
  if (!editor?.ref || !/^\[editor text hidden: \d+ chars, #[0-9a-f]{14}\]$/.test(String(editor.value || ''))) failures.push('contenteditable editor value hidden by length and fingerprint');
  const long = brw08?.longNote;
  if (!long?.ref || long.value !== boundedFieldValue(LONG_NOTE_VALUE)) failures.push('long value as prefix, length and fingerprint');
  if (String(long?.value || '').includes(LONG_NOTE_VALUE)) failures.push('long value never shown whole');
  if (brw08?.fillLongNoteOk !== true || brw08?.longNoteAfterLength !== 8000) failures.push('long fill up to 8000 characters');
  if (brw08?.editorFillOk !== true) failures.push('editor fill');
  if (brw08?.shadowClickOk !== true || brw08?.frameClickOk !== true) failures.push('frame and shadow click');
  return failures;
}

async function main() {
  startMcp();
  pageUrl = await startFixtureServer();

  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'egdesk-firefox-mcp-browser-agent-observation-verify', version: '0.1.0' },
  });
  notify('notifications/initialized');

  const contexts = await callTool('list_privileged_contexts');
  const contextText = resultText(contexts);
  const contextMatch = contextText.match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/);
  if (!contextMatch) throw new Error(`Firefox chrome context not found.\n${contextText}`);
  privilegedContext = contextMatch[1];
  await callTool('select_privileged_context', { contextId: contextMatch[1] });

  const remount = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: remountExpression('egd-browser-agent-observation-style'),
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
          const value = await fn();
          if (value) return value;
          await wait(100);
        }
        throw new Error('timeout');
      };
      return wait(150).then(async () => {
        const api = window.__egdesk;
        const card = api.cardRuntime.openBrowserCard(${JSON.stringify(pageUrl)}, { openMode: 'new' });
        const actionEvents = [];
        const onAgentAction = (event) => actionEvents.push(event.detail);
        window.addEventListener('egdesk:browser-agent-action', onAgentAction);
        let lastSnapshot = null;
        const before = await waitFor(async () => {
          const snapshot = await api.browserAgent.snapshot(card.id);
          lastSnapshot = snapshot;
          return !snapshot.inaccessible && snapshot.interactiveElements.some((item) => item.label === 'Reveal details')
            ? snapshot
            : null;
        }, 12000).catch((error) => {
          return { timeout: true, error: error.message, lastSnapshot };
        });
        if (before.timeout) {
          return {
            timeout: true,
            cardId: card.id,
            lastSnapshot: before.lastSnapshot,
            agentDebug: api.browserAgent.debug(card.id),
            cardState: api.browserRuntime.state(card.id),
          };
        }

        const reveal = before.interactiveElements.find((item) => item.label === 'Reveal details');
        const input = before.interactiveElements.find((item) => item.label === 'Search note' || item.label === 'query');
        // BRW-08: frame, shadow, editor and long value, from the same first observation.
        const byLabel = (label) => before.interactiveElements.find((item) => item.label === label) || null;
        const pick = (item) => item ? { ref: item.ref, role: item.role, tag: item.tag, value: item.value } : null;
        const brw08 = { frameButton: pick(byLabel('Frame send')), frameInput: pick(byLabel('Frame note')),
          shadowButton: pick(byLabel('Shadow save')), editor: pick(byLabel('Message body')), longNote: pick(byLabel('Long note')) };
        const actOk = async (action) => { try { return (await api.browserAgent.act(card.id, action, { settleMs: 50 })).ok === true; } catch { return false; } };
        brw08.frameClickOk = brw08.frameButton ? await actOk({ type: 'click', ref: brw08.frameButton.ref }) : false;
        brw08.shadowClickOk = brw08.shadowButton ? await actOk({ type: 'click', ref: brw08.shadowButton.ref }) : false;
        brw08.editorFillOk = brw08.editor ? await actOk({ type: 'fill', ref: brw08.editor.ref, value: 'Edited body' }) : false;
        brw08.fillLongNoteOk = brw08.longNote ? await actOk({ type: 'fill', ref: brw08.longNote.ref, value: 'x'.repeat(8000) }) : false;
        const longAfter = (await api.browserAgent.snapshot(card.id)).interactiveElements.find((item) => item.label === 'Long note');
        brw08.longNoteAfterLength = Number(String(longAfter?.value || '').match(/\\[(\\d+) chars/)?.[1] || 0);
        // The original history/notification checks below count from here.
        api.browserAgent.clearHistory(card.id);
        actionEvents.length = 0;

        // Headless Firefox gives no window/document focus unless the harness asks for it (BRW-08 focus checks).
        const focusContent = () => {
          window.focus();
          const cardEl = document.getElementById(card.id);
          const browserEl = card._browserControls?.toolBrowser?.() || cardEl?.querySelector('browser');
          browserEl?.focus();
          try { browserEl?.browsingContext?.top?.window?.focus?.(); } catch {}
          return wait(100);
        };
        await focusContent();
        const clickResult = await api.browserAgent.act(card.id, { type: 'click', ref: reveal.ref }, { settleMs: 250 });
        const afterClick = clickResult.after;
        const continueButton = afterClick.interactiveElements.find((item) => item.label === 'Continue');
        const fillResult = await api.browserAgent.act(card.id, { type: 'fill', ref: input.ref, value: '한글 입력' }, { settleMs: 150 });
        const history = api.browserAgent.history(card.id);
        const limitedHistory = api.browserAgent.history(card.id, { limit: 1 });
        const notifications = api.browserAgent.notifications(card.id);
        const limitedNotifications = api.browserAgent.notifications(card.id, { limit: 1 });
        const clearResult = api.browserAgent.clearHistory(card.id);
        const historyAfterClear = api.browserAgent.history(card.id);
        const summarizeEntry = (entry) => ({
          id: entry?.id || '',
          actionType: entry?.action?.type || entry?.action?.action || '',
          ok: !!entry?.ok,
          source: entry?.source || '',
          titleChanged: !!entry?.observation?.titleChanged,
          newVisibleText: entry?.observation?.newVisibleText || [],
          focusedValue: entry?.observation?.focusedElement?.value || '',
          notificationType: entry?.notification?.type || '',
          notificationChanged: !!entry?.notification?.changed,
          notificationSummary: entry?.notification?.summary || '',
        });
        const summarizeNotification = (notification) => ({
          type: notification?.type || '',
          actionType: notification?.actionType || '',
          changed: !!notification?.changed,
          summary: notification?.summary || '',
          focusedValue: notification?.changes?.focusedElement?.value || '',
          newText: notification?.changes?.newVisibleText || [],
        });
        const historySummary = history.map(summarizeEntry);
        const limitedHistorySummary = limitedHistory.map(summarizeEntry);
        const notificationSummary = notifications.map(summarizeNotification);
        const limitedNotificationSummary = limitedNotifications.map(summarizeNotification);
        const eventSummary = actionEvents.map(summarizeEntry);
        window.removeEventListener('egdesk:browser-agent-action', onAgentAction);

        document.querySelectorAll('.egd-canvas-card').forEach((node) => {
          try { if (typeof node._cleanup === 'function') node._cleanup(); } catch {}
          node.remove();
        });
        api.state.sourceRefs.cardsByKey = Object.create(null);
        api.state.agenda.dirty = false;

        return {
          cardId: card.id,
          beforeTitle: before.title,
          beforeText: before.text,
          beforeInteractiveLabels: before.interactiveElements.map((item) => item.label),
          revealRef: reveal.ref,
          inputRef: input?.ref || null,
          clickOk: clickResult.ok,
          clickActionEntry: summarizeEntry(clickResult.actionEntry),
          clickHistoryLength: clickResult.actionHistoryLength,
          clickResult: clickResult.result,
          clickObservation: clickResult.observation,
          clickNotification: clickResult.notification,
          continueRef: continueButton?.ref || null,
          fillOk: fillResult.ok,
          fillActionEntry: summarizeEntry(fillResult.actionEntry),
          fillNotification: fillResult.notification,
          fillHistoryLength: fillResult.actionHistoryLength,
          fillFocusedElement: fillResult.after.focusedElement,
          fillObservation: fillResult.observation,
          historySummary,
          limitedHistorySummary,
          notificationSummary,
          limitedNotificationSummary,
          clearResult,
          historyAfterClearLength: historyAfterClear.length,
          eventSummary,
          brw08,
          cleanupCardCount: document.querySelectorAll('.egd-canvas-card').length,
        };
      });
    })()`,
  }, 30000)));

  const failures = [];
  if (check.timeout) failures.push('initial snapshot timeout');
  if (!check.revealRef || !check.inputRef) failures.push('initial element refs');
  if (!check.clickOk) failures.push('click action');
  if (!check.clickObservation?.titleChanged) failures.push('title diff');
  if (!check.clickObservation?.newVisibleText?.includes('Details ready for the agent')) failures.push('new visible text diff');
  if (!check.clickObservation?.newInteractiveElements?.some((item) => item.label === 'Continue')) failures.push('new interactive element diff');
  if (!check.clickObservation?.focusedElement || check.clickObservation.focusedElement.ref !== check.inputRef) failures.push('focused element observation');
  if (!check.continueRef) failures.push('continue element ref');
  if (!check.fillOk) failures.push('fill action');
  if (check.fillFocusedElement?.value !== '한글 입력') failures.push('hangul fill value');
  if (check.clickHistoryLength !== 1 || check.fillHistoryLength !== 2) failures.push('act return history length');
  if (!check.clickActionEntry?.id || !check.clickActionEntry?.titleChanged) failures.push('click action entry');
  if (!check.fillActionEntry?.id || check.fillActionEntry?.focusedValue !== '한글 입력') failures.push('fill action entry');
  if (check.clickNotification?.type !== 'browser-dom-change' || !check.clickNotification.changed) failures.push('click notification type');
  if (!String(check.clickNotification?.summary || '').includes('Details ready for the agent')) failures.push('click notification summary');
  if (check.fillNotification?.type !== 'browser-dom-change' || !check.fillNotification.changed) failures.push('fill notification type');
  if (!String(check.fillNotification?.summary || '').includes('한글 입력')) failures.push('fill notification summary');
  if (!check.fillNotification?.changes?.focusedElementChanged) failures.push('fill notification focus diff');
  if (!Array.isArray(check.historySummary) || check.historySummary.length !== 2) failures.push('history length');
  if (check.historySummary?.[0]?.id !== check.clickActionEntry?.id || check.historySummary?.[1]?.id !== check.fillActionEntry?.id) failures.push('history order');
  if (!check.historySummary?.[0]?.notificationSummary?.includes('Details ready for the agent')) failures.push('history notification summary');
  if (!Array.isArray(check.limitedHistorySummary) || check.limitedHistorySummary.length !== 1 || check.limitedHistorySummary[0]?.id !== check.fillActionEntry?.id) failures.push('limited history');
  if (!Array.isArray(check.notificationSummary) || check.notificationSummary.length !== 2) failures.push('notification history length');
  if (!check.notificationSummary?.[0]?.summary?.includes('Details ready for the agent')) failures.push('notification history click summary');
  if (!check.limitedNotificationSummary?.[0]?.summary?.includes('한글 입력')) failures.push('limited notification summary');
  if (!Array.isArray(check.eventSummary) || check.eventSummary.length !== 2) failures.push('action event count');
  if (check.eventSummary?.[0]?.id !== check.clickActionEntry?.id || check.eventSummary?.[1]?.id !== check.fillActionEntry?.id) failures.push('action event order');
  if (!check.eventSummary?.[1]?.notificationSummary?.includes('한글 입력')) failures.push('event notification summary');
  if (check.clearResult?.removed !== 2 || check.historyAfterClearLength !== 0) failures.push('clear history');
  if (check.cleanupCardCount !== 0) failures.push('cleanup');
  failures.push(...brw08Failures(check.brw08).map((name) => `BRW-08 ${name}`));
  if (failures.length) {
    throw new Error(`Browser agent observation verification failed (${failures.join(', ')}): ${JSON.stringify(check, null, 2)}`);
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

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  if (stderrBuffer.trim()) {
    console.error('\n[MCP stderr]');
    console.error(stderrBuffer.trim());
  }
  process.exitCode = 1;
}).finally(() => {
  fixtureServer?.close();
  proc?.stdin.end();
  setTimeout(() => proc?.kill('SIGTERM'), 500);
});
