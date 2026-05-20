#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const SCREENSHOT_PATH = process.argv[2] || '/tmp/egdesk-browser-controls-verify.png';

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
      '#egd-rail-search-results',
      '.egd-browser-menu',
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
      hasApi: !!window.__egdesk?.browserRuntime && !!window.__egdesk?.cardRuntime,
      hasRail: !!document.getElementById('egd-desk-rail'),
    };
  })()`;
}

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'egdesk-firefox-mcp-browser-controls-verify', version: '0.1.0' },
  });
  notify('notifications/initialized');

  const contexts = await callTool('list_privileged_contexts');
  const contextText = resultText(contexts);
  const contextMatch = contextText.match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/);
  if (!contextMatch) throw new Error(`Firefox chrome context not found.\n${contextText}`);
  await callTool('select_privileged_context', { contextId: contextMatch[1] });

  const remount = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: remountExpression('egd-browser-controls-live-style'),
  }, 30000)));
  if (!remount.hasApi || !remount.hasRail) {
    throw new Error(`Remount failed: ${JSON.stringify(remount, null, 2)}`);
  }

  const check = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const api = window.__egdesk;
      return wait(150).then(() => {
        const card = api.cardRuntime.openBrowserCard('https://example.com/browser-control-a', { openMode: 'new' });
        return wait(250).then(() => {
          const initial = api.browserRuntime.state(card.id);
          const navState = api.browserRuntime.navigate(card.id, 'https://example.com/browser-control-b');
          return wait(250).then(() => {
            const afterNav = api.browserRuntime.state(card.id);
            const beforeCount = document.querySelectorAll('.egd-browser-card').length;
            const duplicate = api.browserRuntime.duplicate(card.id);
            const afterCount = document.querySelectorAll('.egd-browser-card').length;
            const reloadResult = api.browserRuntime.reload(card.id);
            const stopResult = api.browserRuntime.stop(card.id);
            const homeResult = api.browserRuntime.home(card.id);
            return wait(150).then(() => {
              const afterHome = api.browserRuntime.state(card.id);
              const urlInput = card.querySelector('.egd-card-url');
              urlInput.focus();
              urlInput.value = 'example.org/browser typed?x=1#fragment';
              const enterEvent = new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
                view: window,
              });
              urlInput.dispatchEvent(enterEvent);
              return wait(150).then(() => {
                const afterTypedEnter = api.browserRuntime.state(card.id);
                const escapeValueBefore = urlInput.value;
                urlInput.value = 'temporary invalid draft';
                const escapeEvent = new KeyboardEvent('keydown', {
                  key: 'Escape',
                  bubbles: true,
                  cancelable: true,
                  view: window,
                });
                urlInput.dispatchEvent(escapeEvent);
                const escapeValueAfter = urlInput.value;
                urlInput.value = '';
                urlInput.dispatchEvent(new Event('blur', { bubbles: true }));
                const emptyBlurValue = urlInput.value;
                const backState = api.browserRuntime.back(card.id);
                return wait(150).then(() => {
                  const afterBack = api.browserRuntime.state(card.id);
                  const forwardState = api.browserRuntime.forward(card.id);
                  return wait(150).then(() => {
                    const afterForward = api.browserRuntime.state(card.id);
              const menuButton = card.querySelector('.egd-card-menu');
              menuButton?.click();
              const menu = document.querySelector('.egd-browser-menu');
              const buttons = Array.from(card.querySelectorAll('.egd-card-nav-btn, .egd-card-menu'));
              const menuLabels = Array.from(menu?.querySelectorAll('.egd-browser-menu-item') || []).map((node) => node.textContent.trim());
              const finalState = api.browserRuntime.state(card.id);
              return {
                cardId: card.id,
                hasBrowserApi: !!api.browserRuntime,
                hasControls: !!card._browserControls,
                initial,
                navState,
                afterNav,
                afterHome,
                afterTypedEnter,
                backState,
                afterBack,
                forwardState,
                afterForward,
                finalState,
                duplicateCreated: !!duplicate && afterCount === beforeCount + 1,
                duplicateUri: duplicate?._browserState?.uri || duplicate?.querySelector('.egd-card-url')?.value || null,
                reloadResult,
                stopResult,
                homeResult,
                homeUri: finalState?.uri || null,
                enterDefaultPrevented: enterEvent.defaultPrevented,
                escapeValueBefore,
                escapeValueAfter,
                emptyBlurValue,
                buttonTitles: buttons.map((node) => node.title || ''),
                backDisabled: !!card.querySelector('.egd-card-nav-btn[title="뒤로"]')?.disabled,
                forwardDisabled: !!card.querySelector('.egd-card-nav-btn[title="앞으로"]')?.disabled,
                pageTitle: card.querySelector('.egd-card-page-title')?.textContent?.trim() || '',
                pageStatus: card.querySelector('.egd-card-page-status')?.textContent?.trim() || '',
                securityText: card.querySelector('.egd-card-security')?.textContent?.trim() || '',
                menuOpen: !!menu,
                menuLabels,
                sourceUri: card._sourceRef?.uri || null,
                dirty: api.state.agenda.dirty,
              };
                  });
                });
              });
            });
          });
        });
      });
    })()`,
  }, 30000)));

  const failures = [];
  if (!check.hasBrowserApi || !check.hasControls) failures.push('browser runtime api');
  if (check.afterNav?.uri !== 'https://example.com/browser-control-b') failures.push('navigate state');
  if (check.sourceUri !== check.finalState?.uri) failures.push('source ref follows current uri');
  if (!check.duplicateCreated || check.duplicateUri !== 'https://example.com/browser-control-b') failures.push('duplicate card');
  if (check.reloadResult !== true || check.stopResult !== true) failures.push('reload/stop command');
  if (!check.homeResult || check.afterHome?.uri !== 'https://duckduckgo.com/') failures.push('home command');
  if (check.afterTypedEnter?.uri !== 'https://example.org/browser%20typed?x=1') failures.push('address bar enter normalization');
  if (check.enterDefaultPrevented !== true) failures.push('address bar enter default prevention');
  if (check.escapeValueBefore !== check.afterTypedEnter?.uri || check.escapeValueAfter !== check.afterTypedEnter?.uri) failures.push('address bar escape restore');
  if (check.emptyBlurValue !== check.afterTypedEnter?.uri) failures.push('address bar empty blur restore');
  if (check.afterBack?.uri !== 'https://duckduckgo.com/' || check.afterForward?.uri !== 'https://example.org/browser%20typed?x=1') failures.push('local back/forward history');
  if ((check.finalState?.historyLength || 0) < 4 || check.finalState?.historyIndex !== check.finalState.historyLength - 1) failures.push('history snapshot');
  if (check.homeUri !== 'https://example.org/browser%20typed?x=1') failures.push('final current uri');
  if (!check.buttonTitles.includes('홈') || !check.buttonTitles.includes('복제') || !check.buttonTitles.includes('더보기')) failures.push('toolbar controls');
  if (!check.pageTitle || !check.pageStatus || !check.securityText) failures.push('browser chrome status');
  if (!check.menuOpen || check.menuLabels.length < 5 || !check.menuLabels.includes('URL 복사')) failures.push('browser menu');
  if (!check.dirty) failures.push('agenda dirty');
  if (failures.length) {
    throw new Error(`Browser controls verification failed (${failures.join(', ')}): ${JSON.stringify(check, null, 2)}`);
  }

  const screenshot = resultText(await callTool('screenshot_page', { saveTo: SCREENSHOT_PATH }, 30000));

  const cleanup = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      document.querySelectorAll('.egd-canvas-card, .egd-canvas-shape').forEach((node) => {
        try { if (typeof node._cleanup === 'function') node._cleanup(); } catch {}
        node.remove();
      });
      document.querySelectorAll('.egd-browser-menu').forEach((node) => node.remove());
      api.state.sourceRefs.cardsByKey = Object.create(null);
      api.state.activeEntityId = null;
      api.agenda.clearSavedState();
      api.state.agenda.dirty = false;
      api.state.agenda.dirtyRevision = 0;
      return {
        cardCount: document.querySelectorAll('.egd-canvas-card').length,
        menuOpen: !!document.querySelector('.egd-browser-menu'),
        dirty: api.state.agenda.dirty,
      };
    })()`,
  }, 30000)));
  if (cleanup.cardCount !== 0 || cleanup.menuOpen || cleanup.dirty) {
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
