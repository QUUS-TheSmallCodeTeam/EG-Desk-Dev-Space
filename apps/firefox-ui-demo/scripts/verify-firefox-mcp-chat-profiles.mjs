#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const MARIONETTE_PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const SCREENSHOT_PATH = process.argv[2] || '/tmp/egdesk-chat-profiles-verify.png';

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
      hasApi: !!window.__egdesk?.codexBridge,
      hasDock: !!document.getElementById('egd-dock'),
      hasHud: !!document.getElementById('egd-hud'),
    };
  })()`;
}

async function main() {
  await request('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'egdesk-firefox-mcp-chat-profiles-verify', version: '0.1.0' },
  });
  notify('notifications/initialized');

  const contexts = await callTool('list_privileged_contexts');
  const contextText = resultText(contexts);
  const contextMatch = contextText.match(/\s([0-9a-f-]{36}): chrome:\/\/browser\/content\/browser\.xhtml/);
  if (!contextMatch) throw new Error(`Firefox chrome context not found.\n${contextText}`);
  await callTool('select_privileged_context', { contextId: contextMatch[1] });

  const remount = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: remountExpression('egd-chat-profiles-live-style'),
  }, 30000)));
  if (!remount.hasApi || !remount.hasDock || !remount.hasHud) {
    throw new Error(`Remount failed: ${JSON.stringify(remount, null, 2)}`);
  }

  const profileCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(() => {
      const api = window.__egdesk;
      const profiles = api.codexBridge.agentProfiles();
      const dm = api.state.codex.threads.find((thread) => thread.type === 'dm');
      const agenda = api.state.codex.threads.find((thread) => thread.type === 'group');
      const dmConfig = api.codexBridge.threadRuntimeConfig(dm?.id);
      const agendaConfig = api.codexBridge.threadRuntimeConfig(agenda?.id);
      api.codexBridge.createThread('dm', { agentProfileId: 'implementation-worker', openConversation: false });
      const created = api.state.codex.threads[0];
      const createdConfig = api.codexBridge.threadRuntimeConfig(created.id);
      api.codexBridge.setThreadAgentProfile(created.id, 'review-verifier');
      const updatedConfig = api.codexBridge.threadRuntimeConfig(created.id);
      return {
        profileIds: profiles.map((profile) => profile.id),
        dmProfile: dmConfig.agentProfile.id,
        agendaProfile: agendaConfig.agentProfile.id,
        createdProfile: createdConfig.agentProfile.id,
        updatedProfile: updatedConfig.agentProfile.id,
        updatedToolMode: updatedConfig.toolMode,
        updatedPrompt: updatedConfig.systemPrompt,
        createdThreadId: created.id,
      };
    })()`,
  }, 30000)));

  const payloadCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(async () => {
      const api = window.__egdesk;
      const threadId = ${JSON.stringify(profileCheck.createdThreadId)};
      let captured = null;
      const originalFetch = window.fetch;
      window.fetch = async (url, init = {}) => {
        captured = {
          url: String(url),
          body: init.body ? JSON.parse(String(init.body)) : null,
        };
        return {
          ok: true,
          status: 202,
          statusText: 'Accepted',
          json: async () => ({ accepted: true, conversationId: 'conversation-profile-verify' }),
          text: async () => '',
        };
      };
      try {
        api.state.codex.authStatus = { ...api.state.codex.authStatus, isLoggedIn: true };
        api.codexBridge.selectThread(threadId, { openConversation: true });
        api.codexBridge.setDraft('profile payload verification', threadId);
        await api.codexBridge.sendMessage();
      } finally {
        window.fetch = originalFetch;
        api.state.codex.isSending = false;
      }
      const thread = api.state.codex.threads.find((entry) => entry.id === threadId);
      return {
        captured,
        conversationId: thread?.conversationId || null,
        sentProfile: captured?.body?.agentProfile?.id || null,
        sentToolMode: captured?.body?.toolMode || null,
        sentThreadTitle: captured?.body?.thread?.title || null,
        sentPrompt: captured?.body?.systemPrompt || '',
      };
    })()`,
  }, 30000)));

  const visualCheck = parseToolJson(resultText(await callTool('evaluate_privileged_script', {
    expression: `(async () => {
      const api = window.__egdesk;
      const threadId = ${JSON.stringify(profileCheck.createdThreadId)};
      api.state.hudOpen = false;
      document.getElementById('egd-hud')?.classList.add('egd-hud-hidden');
      api.codexBridge.selectThread(threadId, { openConversation: true });
      document.querySelector('.egd-dock-btn[data-id="chat"]')?.click();
      api.codexBridge.selectThread(threadId, { openConversation: true });
      await new Promise((resolve) => setTimeout(resolve, 320));
      const hud = document.getElementById('egd-hud');
      const hudRect = hud?.getBoundingClientRect();
      const userBubble = document.querySelector('.egd-codex-bubble-user');
      const userBubbleRect = userBubble?.getBoundingClientRect();
      const profileChipNodes = Array.from(document.querySelectorAll('.egd-codex-agent-profile-chip'));
      const toolChipNodes = Array.from(document.querySelectorAll('.egd-codex-tool-mode-chip'));
      const profileChips = profileChipNodes.map((node) => node.textContent.trim());
      const toolChips = toolChipNodes.map((node) => node.textContent.trim());
      const visibleProfileChips = profileChipNodes.filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
      }).map((node) => node.textContent.trim());
      const visibleToolChips = toolChipNodes.filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < window.innerWidth && rect.top < window.innerHeight;
      }).map((node) => node.textContent.trim());
      const activeThread = api.state.codex.threads.find((entry) => entry.id === threadId);
      return {
        hudOpen: api.state.hudOpen,
        hudApp: api.state.hudApp,
        hudView: api.state.codex.hudView,
        innerWidth: window.innerWidth,
        docClientWidth: document.documentElement.clientWidth,
        hudStyle: hud?.getAttribute('style') || '',
        hudComputedLeft: hud ? getComputedStyle(hud).left : '',
        hudComputedRight: hud ? getComputedStyle(hud).right : '',
        hudHidden: !!hud?.classList.contains('egd-hud-hidden'),
        hudRect: hudRect ? { left: hudRect.left, top: hudRect.top, right: hudRect.right, width: hudRect.width, height: hudRect.height } : null,
        hudInsideViewport: !!(hudRect && hudRect.left >= -1 && hudRect.right <= window.innerWidth + 1 && hudRect.top >= -1 && hudRect.bottom <= window.innerHeight + 1),
        hudRightGap: hudRect ? window.innerWidth - hudRect.right : null,
        userBubbleRect: userBubbleRect ? { left: userBubbleRect.left, right: userBubbleRect.right, width: userBubbleRect.width } : null,
        userBubbleInsideHud: !!(hudRect && userBubbleRect && userBubbleRect.left >= hudRect.left - 1 && userBubbleRect.right <= hudRect.right + 1),
        activeProfile: activeThread?.agentProfileId || null,
        profileChips,
        toolChips,
        visibleProfileChips,
        visibleToolChips,
        hasReviewChip: profileChips.includes('Verify'),
        hasVerificationToolChip: toolChips.includes('verification'),
        hasVisibleReviewChip: visibleProfileChips.includes('Verify'),
        hasVisibleVerificationToolChip: visibleToolChips.includes('verification'),
      };
    })()`,
  }, 30000)));

  const screenshot = resultText(await callTool('screenshot_page', { saveTo: SCREENSHOT_PATH }, 30000));

  const failures = [];
  const expectedProfiles = [
    'conversational-coding',
    'tool-operator',
    'coding-project-manager',
    'codebase-explorer',
    'implementation-worker',
    'review-verifier',
  ];
  for (const id of expectedProfiles) {
    if (!profileCheck.profileIds.includes(id)) failures.push(`missing profile ${id}`);
  }
  if (profileCheck.dmProfile !== 'conversational-coding') failures.push('default dm profile');
  if (profileCheck.agendaProfile !== 'coding-project-manager') failures.push('default agenda profile');
  if (profileCheck.createdProfile !== 'implementation-worker') failures.push('created profile option');
  if (profileCheck.updatedProfile !== 'review-verifier') failures.push('profile update');
  if (profileCheck.updatedToolMode !== 'verification') failures.push('profile tool mode');
  if (!profileCheck.updatedPrompt.includes('review and verification agent')) failures.push('profile system prompt');
  if (payloadCheck.sentProfile !== 'review-verifier') failures.push('send payload profile');
  if (payloadCheck.sentToolMode !== 'verification') failures.push('send payload tool mode');
  if (!payloadCheck.sentPrompt.includes('review and verification agent')) failures.push('send payload system prompt');
  if (!payloadCheck.conversationId) failures.push('send payload conversation id');
  if (!visualCheck.hudOpen || visualCheck.hudApp !== 'chat' || visualCheck.hudView !== 'conversation' || visualCheck.hudHidden) failures.push('chat hud open');
  if (!visualCheck.hudRect || visualCheck.hudRect.width <= 0 || visualCheck.hudRect.height <= 0) failures.push('chat hud rectangle');
  if (!visualCheck.hudInsideViewport) failures.push('chat hud viewport fit');
  if (visualCheck.hudRightGap == null || visualCheck.hudRightGap < 0 || visualCheck.hudRightGap > 24) failures.push('chat hud right dock');
  if (!visualCheck.userBubbleInsideHud) failures.push('user bubble overflow');
  if (!visualCheck.hasVisibleReviewChip || !visualCheck.hasVisibleVerificationToolChip) failures.push('profile chips visible');

  if (failures.length) {
    throw new Error(`Chat profile verification failed (${failures.join(', ')}): ${JSON.stringify({
      profileCheck,
      payloadCheck,
      visualCheck,
    }, null, 2)}`);
  }

  console.log(JSON.stringify({
    ok: true,
    contextId: contextMatch[1],
    screenshot: SCREENSHOT_PATH,
    remount,
    profileCheck,
    payloadCheck,
    visualCheck,
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
