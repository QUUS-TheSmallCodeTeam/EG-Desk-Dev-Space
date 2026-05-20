#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const SCREENSHOT_PATH = process.argv[2] || '/tmp/egdesk-rail-search-verify.png';

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
      hasApi: !!window.__egdesk?.railSearch && !!window.__egdesk?.agenda,
      hasRail: !!document.getElementById('egd-desk-rail'),
      hasInput: !!document.querySelector('.egd-rail-search-input'),
    };
  })()`;
}

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'egdesk-firefox-mcp-rail-search-verify', version: '0.1.0' },
  });
  notify('notifications/initialized');

  const contexts = await callTool('list_privileged_contexts');
  const contextText = resultText(contexts);
  const contextMatch = contextText.match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/);
  if (!contextMatch) throw new Error(`Firefox chrome context not found.\n${contextText}`);
  await callTool('select_privileged_context', { contextId: contextMatch[1] });

  const remount = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: remountExpression('egd-rail-search-live-style'),
  }, 30000)));
  if (!remount.hasApi || !remount.hasRail || !remount.hasInput) {
    throw new Error(`Remount failed: ${JSON.stringify(remount, null, 2)}`);
  }

  const setup = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      api.agenda.clearSavedState();
      api.agenda.clearView();

      api.state.agenda.activeAgendaId = 'agenda-rail-alpha';
      api.state.agenda.activeTitle = 'Rail Alpha';
      const alpha = api.cardRuntime.openBrowserCard('https://example.com/rail-alpha', { openMode: 'new' });
      api.agenda.markDirty('rail-alpha-setup', alpha);
      api.agenda.save();

      api.agenda.create({ force: true });
      api.state.agenda.activeTitle = 'Rail Beta';
      const beta = api.cardRuntime.openBrowserCard('https://example.com/rail-beta', { openMode: 'new' });
      api.agenda.markDirty('rail-beta-setup', beta);
      api.agenda.save();

      api.state.codex.threads = [{
        id: 'thread-rail-design',
        type: 'group',
        title: 'Rail Design Thread',
        subtitle: 'Agenda Thread · 멤버 2명',
        participants: ['나', '코덱스 어시스턴트'],
        participantRoles: { '나': 'owner', '코덱스 어시스턴트': 'admin' },
        pinned: false,
        conversationId: 'conversation-rail-design',
        messages: [{
          id: 'message-rail-design',
          role: 'assistant',
          content: 'Rail search verification note',
          status: 'complete',
          readBy: [],
          createdAt: Date.now(),
        }],
        unreadCount: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }, ...api.state.codex.threads.filter((thread) => thread.id !== 'thread-rail-design')];

      api.railSearch.setQuery('Rail');
      return {
        activeTitle: api.state.agenda.activeTitle,
        results: api.railSearch.results(),
        panelOpen: !!document.getElementById('egd-rail-search-results'),
        rowCount: document.querySelectorAll('.egd-rail-search-result').length,
      };
    })()`,
  }, 30000)));

  const agendaCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      api.railSearch.setQuery('Alpha');
      const results = api.railSearch.results();
      const agenda = results.find((result) => result.type === 'agenda' && result.title === 'Rail Alpha');
      const executed = api.railSearch.execute(agenda?.key);
      const card = document.querySelector('.egd-browser-card');
      return {
        hadAgenda: !!agenda,
        executed,
        activeTitle: api.state.agenda.activeTitle,
        activeId: api.state.agenda.activeAgendaId,
        uri: card?.querySelector('.egd-card-url')?.value || null,
        panelOpen: !!document.getElementById('egd-rail-search-results'),
      };
    })()`,
  }, 30000)));

  const historyCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      const before = document.querySelectorAll('.egd-browser-card').length;
      api.railSearch.setQuery('rail-beta');
      const results = api.railSearch.results();
      const history = results.find((result) => result.type === 'history' && result.title.includes('rail-beta'));
      const executed = api.railSearch.execute(history?.key);
      const active = document.getElementById(api.state.activeEntityId);
      return {
        before,
        after: document.querySelectorAll('.egd-browser-card').length,
        hadHistory: !!history,
        executed,
        activeUri: active?.querySelector('.egd-card-url')?.value || null,
        panelOpen: !!document.getElementById('egd-rail-search-results'),
      };
    })()`,
  }, 30000)));

  const cardCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      const card = api.cardRuntime.openBrowserCard('https://example.com/rail-card-match', { openMode: 'new' });
      api.railSearch.setQuery('rail-card-match');
      const results = api.railSearch.results();
      const cardResult = results.find((result) => result.type === 'card' && result.subtitle.includes('rail-card-match'));
      const executed = api.railSearch.execute(cardResult?.key);
      return {
        hadCard: !!cardResult,
        executed,
        cardId: card.id,
        activeEntityId: api.state.activeEntityId,
        panelOpen: !!document.getElementById('egd-rail-search-results'),
      };
    })()`,
  }, 30000)));

  const tabCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      const card = api.cardRuntime.openBrowserCard('https://example.com/rail-tab-existing', { openMode: 'new' });
      const input = document.querySelector('.egd-rail-search-input');
      input.value = 'https://example.com/rail-tab-existing';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      return {
        cardId: card.id,
        activeEntityId: api.state.activeEntityId,
        prevented: event.defaultPrevented,
        inputValue: input.value,
        panelOpen: !!document.getElementById('egd-rail-search-results'),
      };
    })()`,
  }, 30000)));

  const webCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      const before = document.querySelectorAll('.egd-browser-card').length;
      const input = document.querySelector('.egd-rail-search-input');
      input.value = 'https://example.com/rail-new-card';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
      input.dispatchEvent(event);
      const cards = Array.from(document.querySelectorAll('.egd-browser-card'));
      const active = document.getElementById(api.state.activeEntityId);
      return {
        before,
        after: cards.length,
        prevented: event.defaultPrevented,
        activeUri: active?.querySelector('.egd-card-url')?.value || null,
        panelOpen: !!document.getElementById('egd-rail-search-results'),
      };
    })()`,
  }, 30000)));

  const threadCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      api.state.codex.chatDockMode = 'hud';
      api.state.codex.chatCardEntityId = null;
      api.railSearch.setQuery('Rail Design');
      const results = api.railSearch.results();
      const thread = results.find((result) => result.type === 'thread' && result.title === 'Rail Design Thread');
      const executed = api.railSearch.execute(thread?.key);
      return {
        hadThread: !!thread,
        executed,
        activeThreadId: api.state.codex.activeThreadId,
        hudOpen: api.state.hudOpen,
        hudApp: api.state.hudApp,
        hudView: api.state.codex.hudView,
      };
    })()`,
  }, 30000)));

  const fileCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(async () => {
      const api = window.__egdesk;
      api.railSearch.setQuery('verify-firefox-mcp-rail-search');
      await new Promise((resolve) => setTimeout(resolve, 420));
      const results = api.railSearch.results();
      const file = results.find((result) => result.type === 'file' && result.title === 'verify-firefox-mcp-rail-search.mjs');
      const executed = api.railSearch.execute(file?.key);
      const active = document.getElementById(api.state.activeEntityId);
      return {
        hadFile: !!file,
        executed,
        activeUri: active?.querySelector('.egd-card-url')?.value || null,
        panelOpen: !!document.getElementById('egd-rail-search-results'),
      };
    })()`,
  }, 30000)));

  const visualCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      api.railSearch.setQuery('Rail');
      const panelRect = document.getElementById('egd-rail-search-results')?.getBoundingClientRect();
      const hud = document.getElementById('egd-hud');
      const hudRect = hud && !hud.classList.contains('egd-hud-hidden') ? hud.getBoundingClientRect() : null;
      const overlapsHud = !!(panelRect && hudRect
        && panelRect.left < hudRect.right
        && panelRect.right > hudRect.left
        && panelRect.top < hudRect.bottom
        && panelRect.bottom > hudRect.top);
      return {
        panelOpen: !!document.getElementById('egd-rail-search-results'),
        panelRight: panelRect?.right || null,
        hudLeft: hudRect?.left || null,
        overlapsHud,
        sections: Array.from(document.querySelectorAll('.egd-rail-search-section')).map((node) => node.textContent),
        rowCount: document.querySelectorAll('.egd-rail-search-result').length,
        activeCount: document.querySelectorAll('.egd-rail-search-result-active').length,
      };
    })()`,
  }, 30000)));

  const screenshot = resultText(await callTool('screenshot_page', { saveTo: SCREENSHOT_PATH }, 30000));

  const cleanup = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      api.railSearch.close({ clearQuery: true });
      api.agenda.clearSavedState();
      api.agenda.close({ force: true });
      api.state.codex.threads = api.state.codex.threads.filter((thread) => thread.id !== 'thread-rail-design');
      return {
        dirty: api.state.agenda.dirty,
        hasSavedState: api.state.agenda.hasSavedState,
        cardCount: document.querySelectorAll('.egd-canvas-card').length,
        panelOpen: !!document.getElementById('egd-rail-search-results'),
      };
    })()`,
  }, 30000)));

  const failures = [];
  if (!setup.panelOpen || setup.rowCount < 3 || !setup.results.some((result) => result.type === 'agenda')) failures.push('initial result panel');
  if (!agendaCheck.hadAgenda || !agendaCheck.executed || agendaCheck.activeTitle !== 'Rail Alpha' || agendaCheck.uri !== 'https://example.com/rail-alpha') failures.push('agenda execution');
  if (!historyCheck.hadHistory || !historyCheck.executed || historyCheck.after !== historyCheck.before + 1 || historyCheck.activeUri !== 'https://example.com/rail-beta' || historyCheck.panelOpen) failures.push('history execution');
  if (!cardCheck.hadCard || !cardCheck.executed || cardCheck.activeEntityId !== cardCheck.cardId) failures.push('card execution');
  if (!tabCheck.prevented || tabCheck.activeEntityId !== tabCheck.cardId || tabCheck.inputValue !== '' || tabCheck.panelOpen) failures.push('tab focus existing');
  if (!webCheck.prevented || webCheck.after !== webCheck.before + 1 || webCheck.activeUri !== 'https://example.com/rail-new-card' || webCheck.panelOpen) failures.push('enter opens web card');
  if (!threadCheck.hadThread || !threadCheck.executed || threadCheck.activeThreadId !== 'thread-rail-design' || !threadCheck.hudOpen || threadCheck.hudApp !== 'chat' || threadCheck.hudView !== 'conversation') failures.push('thread execution');
  if (!fileCheck.hadFile || !fileCheck.executed || !fileCheck.activeUri?.startsWith('file:///') || !fileCheck.activeUri.includes('verify-firefox-mcp-rail-search.mjs') || fileCheck.panelOpen) failures.push('file execution');
  if (!visualCheck.panelOpen || visualCheck.rowCount < 3 || visualCheck.activeCount !== 1 || visualCheck.overlapsHud) failures.push('visual panel state');
  if (cleanup.dirty || cleanup.hasSavedState || cleanup.cardCount !== 0 || cleanup.panelOpen) failures.push('cleanup');
  if (failures.length) {
    throw new Error(`Rail search verification failed (${failures.join(', ')}): ${JSON.stringify({
      setup,
      agendaCheck,
      historyCheck,
      cardCheck,
      tabCheck,
      webCheck,
      threadCheck,
      fileCheck,
      visualCheck,
      cleanup,
    }, null, 2)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    contextId: contextMatch[1],
    screenshot: SCREENSHOT_PATH,
    remount,
    setup,
    agendaCheck,
    historyCheck,
    cardCheck,
    tabCheck,
    webCheck,
    threadCheck,
    fileCheck,
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
