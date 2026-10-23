#!/usr/bin/env node

// Run against Main's already-booted, disposable egdesk-chat-test-* profile only.
// No remount, product fixtures, login, real send, dependency install, or Firefox shutdown.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MCP_PACKAGE = process.env.EGDESK_FIREFOX_MCP_PACKAGE || '@mozilla/firefox-devtools-mcp-moz@latest';
const FIXTURE_FILE_PATH = fileURLToPath(import.meta.url);
const FIXTURE_FILE_URL = import.meta.url;
const PORT = process.env.EGDESK_MARIONETTE_PORT || '2828';
const SCREENSHOT = process.argv[2] || true; // Tool-owned output by default; "-" skips.
const requestedVisualHoldMs = Number(process.env.EGDESK_QA_VISUAL_HOLD_MS ?? 0);
const VISUAL_HOLD_MS = Number.isFinite(requestedVisualHoldMs)
  ? Math.min(30_000, Math.max(0, Math.trunc(requestedVisualHoldMs))) : 0;
const SLOT = '__egdeskChatInteractionTest';
const RUN = `chat-interaction-${Date.now()}-${process.pid}`;
const events = [];
let context;
let initialized = false;
let fixtureReady = false;
let visualFixtureReady = false;
let stderr = '';
let buffer = '';
let nextId = 1;
let toolSchemas = new Map();
let screenshotPath = null;
const pending = new Map();

// Reuse an installed/cached MCP, never install a dependency for this test.
const proc = spawn('npx', [
  '--no-install', MCP_PACKAGE, '--connectExisting', '--marionettePort', PORT,
  '--enablePrivilegedContext', '--enableScript',
  ...(typeof SCREENSHOT === 'string' && SCREENSHOT !== '-' ? ['--unrestricted-save-paths'] : []),
], { stdio: ['pipe', 'pipe', 'pipe'] });

function rejectPending(error) {
  for (const item of pending.values()) item.reject(error);
  pending.clear();
}
proc.on('error', rejectPending);
proc.on('exit', (code, signal) => rejectPending(new Error(`MCP exited: ${code ?? signal}`)));
proc.stdin.on('error', rejectPending);
proc.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
proc.stdout.on('data', (chunk) => {
  buffer += chunk;
  let end;
  while ((end = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, end).trim();
    buffer = buffer.slice(end + 1);
    if (!line.startsWith('{')) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    const item = pending.get(message.id);
    if (!item) continue;
    pending.delete(message.id);
    if (message.error) item.reject(new Error(JSON.stringify(message.error)));
    else item.resolve(message.result);
  }
});

function request(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out: ${method}; no automatic action retry`));
    }, timeoutMs);
    pending.set(id, {
      resolve(value) { clearTimeout(timer); resolve(value); },
      reject(error) { clearTimeout(timer); reject(error); },
    });
    proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function resultText(result) {
  return (result?.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

async function callTool(name, args = {}, timeoutMs = 30000) {
  const result = await request('tools/call', { name, arguments: args }, timeoutMs);
  const text = resultText(result);
  if (result?.isError || /^Error:/m.test(text.trim())) throw new Error(`${name}: ${text}`);
  return result;
}

function parseResult(result) {
  if (result.structuredContent != null) return result.structuredContent;
  const raw = resultText(result).trim();
  const fenced = raw.match(/```json\s*\n([\s\S]*?)\n```/);
  return JSON.parse(fenced ? fenced[1] : raw.replace(/^Result:\s*/, ''));
}

async function evaluate(fn, arg = null, needsFixture = true) {
  const source = `async () => {
    const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
    const profile = services.dirsvc.get('ProfD', Ci.nsIFile).path;
    if (!profile.includes('egdesk-chat-test-')) throw new Error('REFUSED non-test Firefox profile: ' + profile);
    const h = window[${JSON.stringify(SLOT)}];
    ${needsFixture ? `if (!h || h.run !== ${JSON.stringify(RUN)}) throw new Error('Test fixture ownership lost');` : ''}
    return await (${fn.toString()})(${JSON.stringify(arg)});
  }`;
  const bytes = Buffer.byteLength(source, 'utf8');
  if (bytes >= 16 * 1024) throw new Error(`Privileged evaluation too large: ${bytes} bytes`);
  // Current MCP schema requires BOTH context and a callable function string.
  return parseResult(await callTool('evaluate_privileged_script', { context, function: source }));
}

function report(story, assertions, evidence = {}) {
  const entry = { story, ok: assertions.every((item) => item.ok), assertions, ...evidence };
  events.push(entry);
  console.log(JSON.stringify(entry));
  return entry;
}

function check(assertion, ok) { return { assertion, ok: Boolean(ok) }; }

async function story(name, fn) {
  try {
    const { assertions, ...evidence } = await fn();
    return report(name, assertions, evidence);
  } catch (error) {
    report(name, [check('story completed', false)], { error: error.message });
    throw error; // Ambiguous MCP/action failures must not be retried as UI input.
  }
}

async function setup() {
  return evaluate(async function ({ slot, run, fixtureFilePath, fixtureFileUrl }) {
    const api = window.__egdesk;
    if (!api?.state || !api.codexBridge || !document.querySelector('#egd-dock')) {
      throw new Error('Main must boot the current app before running this test; remounting is forbidden');
    }
    if (window[slot]) throw new Error('A prior interaction fixture still exists; refusing to overwrite it');
    for (const method of ['createThread', 'selectThread', 'setDraft', 'setHudView', 'threadRuntimeConfig', 'runState']) {
      if (typeof api.codexBridge[method] !== 'function') throw new Error(`Missing bridge API: ${method}`);
    }
    if (!api.cardRuntime?.openBrowserCard || !api.cardRuntime?.closeCard) throw new Error('Missing card runtime');
    if (api.state.codex.isSending || api.state.codex.isStartingLogin || api.state.codex.authStatus.loginInProgress ||
        api.state.codex.authStatus.isLoggedIn || api.state.codex.codexAccountKey) {
      throw new Error('REFUSED busy or signed-in test profile');
    }
    if (api.state.codex.chatCardEntityId || document.querySelector('.egd-chat-card')) {
      throw new Error('REFUSED pre-existing canvas chat; start with a fresh test profile');
    }
    const clone = (value) => JSON.parse(JSON.stringify(value));
    const h = window[slot] = {
      run, api, clone, requests: [], mockResponses: [], mockRunIds: [], mockConversationIds: [],
      sendPermit: null, blocked: [], threadIds: [], cardIds: [],
      savedCodex: clone(api.state.codex), liveProtocol: api.state.codex.chatProtocol,
      savedAgenda: clone(api.state.agenda),
      savedHud: { open: api.state.hudOpen, app: api.state.hudApp },
      savedCamera: { pan: { ...api.state.panTarget }, zoom: api.state.zoomTarget },
      savedActive: api.state.activeEntityId, savedTool: api.state.activeTool,
      originalFetch: window.fetch, originalEventSource: window.EventSource,
      mockSources: [], stateReads: 0, authWrites: 0, originalFocus: document.activeElement,
      fixture: { authorName: 'Rio', userAuthorName: 'Local test user',
        assistantText: 'Fixture reply.', userText: 'Fixture request.',
        boundLabel: 'Bound fixture file', unboundLabel: 'Unavailable fixture file',
        filePath: fixtureFilePath, fileUrl: fixtureFileUrl },
    };
    h.raw = (value) => {
      if (!value || typeof value !== 'object') return value;
      try { return Components.utils.waiveXrays(value); } catch { return value.wrappedJSObject || value; }
    };
    h.chatState = ChromeUtils.importESModule('chrome://userchrome/content/EGDeskChatState.sys.mjs');
    const codexState = h.raw(api.state.codex);
    h.authDescriptor = Object.getOwnPropertyDescriptor(codexState, 'authStatus');
    if (!h.authDescriptor?.configurable) throw new Error('REFUSED non-configurable test auth state');
    h.fixtureAuth = { isLoggedIn: true, loginInProgress: false, identityStatus: 'verified',
      authMode: 'fixture', accountId: `egdesk-qa-${run}`, accountEmail: null,
      provider: 'codex', statusText: 'QA fixture only' };
    // Keep the disposable, in-memory login fixture stable while the already
    // mounted bridge receives real logged-out status events. Never log in.
    Object.defineProperty(codexState, 'authStatus', {
      configurable: true, enumerable: h.authDescriptor.enumerable,
      get: () => h.fixtureAuth,
      set: () => { h.authWrites++; },
    });
    h.restoreAuth = () => Object.defineProperty(codexState, 'authStatus', h.authDescriptor);
    h.protocolRecords = () => {
      const protocol = h.liveProtocol;
      return { protocol, requests: h.raw(protocol.requests), runs: h.raw(protocol.runs) };
    };
    h.frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    h.must = (node, label) => { if (!node) throw new Error(`Missing mounted ${label}`); return node; };
    h.root = () => h.must(document.getElementById(api.state.codex.chatCardEntityId) || document.getElementById('egd-hud'), 'chat root');
    h.input = () => h.must(h.root().querySelector('.egd-codex-input'), 'composer');
    h.messages = () => h.must(h.root().querySelector('.egd-codex-messages'), 'message log');
    h.rect = (node) => {
      const r = node.getBoundingClientRect();
      return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    };
    h.camera = () => ({ pan: { ...api.state.pan }, target: { ...api.state.panTarget }, zoom: api.state.zoomTarget });
    h.auth = () => { api.state.codex.isStartingLogin = false; };
    h.select = (id) => {
      h.auth(); // Set before any selectThread emit, so the mounted composer exists.
      api.codexBridge.selectThread(id, { openConversation: true });
      api.codexBridge.setHudView('conversation');
    };
    h.read = () => {
      const input = h.input();
      const cssHeight = parseFloat(getComputedStyle(input).height);
      const visualHeight = h.rect(input).height;
      return { value: input.value, height: input.clientHeight, cssHeight, visualHeight,
        renderScale: input.clientHeight ? visualHeight / input.clientHeight : null, scrollHeight: input.scrollHeight,
        clientHeight: input.clientHeight, overflowY: getComputedStyle(input).overflowY,
        lineHeight: parseFloat(getComputedStyle(input).lineHeight),
        focused: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd,
        direction: input.selectionDirection, threadId: input.dataset.threadId,
        draft: api.state.codex.threadDrafts[input.dataset.threadId], calls: h.requests.length };
    };
    h.type = async (text) => {
      const input = h.input();
      input.focus({ preventScroll: true });
      input.value = text;
      input.setSelectionRange(text.length, text.length);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      await h.frame();
      return h.read();
    };
    h.finishMock = () => {
      // The HTTP stub has no bridge SSE completion. Settle only test-owned
      // runs and remove their synthetic native binding before the next send.
      const { protocol, requests, runs } = h.protocolRecords();
      const room = api.state.codex.threads.find((thread) => thread.id === h.roomA);
      for (let index = 0; index < h.mockRunIds.length; index++) {
        const requestId = h.requests[index]?.body?.requestId;
        const conversationId = h.mockConversationIds[index];
        const runId = h.mockRunIds[index];
        const mockRun = h.raw(runs[`${conversationId}/${runId}`]) ||
          h.raw(h.chatState.runsForThread(protocol, room).find((item) =>
            item.conversationId === conversationId && item.runId === runId));
        const mockRequest = h.raw(requests[requestId]);
        if (!mockRun || mockRun.runId !== runId || mockRun.requestId !== requestId ||
            mockRequest?.status !== 'accepted') {
          throw new Error(`Fixture acceptance missing before mock completion: ${JSON.stringify({
            index, runId, runStatus: mockRun?.status || null, requestStatus: mockRequest?.status || null,
          })}`);
        }
        if (mockRun.status !== 'completed') {
          h.chatState.reduceChatEvent(protocol, { type: 'chat.event', v: 2, provider: 'codex',
            event: 'run.completed', streamId: `${h.run}-fixture-completion`, seq: index + 1, ts: Date.now(),
            requestId, clientThreadId: h.requests[index].body.clientThreadId,
            conversationId, runId, details: { status: 'completed' } });
          if (mockRun.status !== 'completed') throw new Error(`Fixture run did not complete: ${runId}`);
        }
      }
      if (room && h.mockConversationIds.includes(room.conversationId)) {
        room.conversationId = null;
        room.bindingAccountKey = null;
        room.bindingState = null;
      }
      h.select(api.state.codex.activeThreadId);
      if (api.state.codex.isSending) throw new Error('Fixture mock completion did not release the composer');
    };
    // Isolate only the local Codex bridge. Its 1200ms reconnect loop otherwise
    // emits during UID acquisition, replacing the input before press_key arrives.
    window.EventSource = function (url, options) {
      const parsed = new URL(String(url), window.location.href);
      if (parsed.origin !== 'http://127.0.0.1:39218') return new h.originalEventSource(url, options);
      const source = new EventTarget();
      Object.assign(source, { url: parsed.href, readyState: 1, withCredentials: false,
        CONNECTING: 0, OPEN: 1, CLOSED: 2, onopen: null, onerror: null, onmessage: null,
        close() { this.readyState = 2; } });
      h.mockSources.push(source);
      return source; // Intentionally no events and no network connection.
    };
    Object.assign(window.EventSource, { CONNECTING: 0, OPEN: 1, CLOSED: 2 });
    window.fetch = async function (resource, options = {}) {
      const url = new URL(typeof resource === 'string' ? resource : resource.url || String(resource), window.location.href);
      const method = String(options.method || resource?.method || 'GET').toUpperCase();
      if (url.origin === 'http://127.0.0.1:39218' && url.pathname === '/v1/state' && method === 'GET') {
        h.stateReads += 1;
        return new Response(JSON.stringify({ provider: 'codex', protocolVersion: api.state.codex.protocolVersion,
          auth: h.fixtureAuth }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (/\/(?:auth|login)(?:\/|$)/i.test(url.pathname)) {
        h.blocked.push({ kind: 'auth', path: url.pathname, method });
        throw new Error('Interaction test forbids auth/login requests');
      }
      if (url.pathname === '/chat/send') {
        let body;
        try { body = JSON.parse(String(options.body || '')); } catch { body = null; }
        const permit = h.sendPermit;
        if (url.origin !== 'http://127.0.0.1:39218' || method !== 'POST' ||
            !permit || permit.roomId !== h.roomA || h.api.state.codex.activeThreadId !== h.roomA ||
            body?.clientThreadId !== permit.clientThreadId || body?.message !== permit.message ||
            body?.profileEnabled !== permit.profileEnabled || typeof body?.requestId !== 'string' ||
            !/^request-[a-z0-9-]+$/i.test(body.requestId) || Object.hasOwn(body, 'conversationId') ||
            Object.hasOwn(body, 'selectedSources') || Object.hasOwn(body, 'executionPolicy')) {
          h.blocked.push({ kind: 'unsafe-send', path: url.pathname, method });
          throw new Error('Interaction test refused an unexpected chat submission');
        }
        h.sendPermit = null; // One exact room/text submission per armed fixture.
        h.requests.push({ url: url.href, method, body: clone(body) });
        const conversationId = `${run}-mock-conversation-${h.requests.length}`;
        const runId = `${run}-mock-turn-${h.requests.length}`;
        const response = { accepted: true, requestId: body.requestId, clientThreadId: body.clientThreadId,
          conversationId, runId, answerId: `${conversationId}/${runId}` };
        // A plain object written from this privileged evaluator is seen as an
        // empty Xray object by a later evaluator. Strings cross that boundary.
        h.mockResponses.push(JSON.stringify(response));
        h.mockRunIds.push(runId);
        h.mockConversationIds.push(conversationId);
        return new Response(JSON.stringify(response), {
          status: 202, headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.origin === 'http://127.0.0.1:39218' && method === 'POST' && url.pathname.startsWith('/chat/')) {
        h.blocked.push({ kind: 'unexpected-chat-action', path: url.pathname, method });
        throw new Error('Interaction test forbids non-fixture chat actions');
      }
      return h.originalFetch.call(this, resource, options); // Do not fake unrelated app traffic.
    };
    // Allow one already-scheduled reconnect to consume the successful local stub.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    api.state.agenda.suppressDirty = true; // Fixtures must never be agenda-save content.
    h.auth();
    h.must(document.querySelector('.egd-dock-btn[data-id="select"]'), 'selection tool').click();
    for (const suffix of ['A', 'B']) {
      api.codexBridge.createThread('dm', { openConversation: false });
      const thread = h.must(api.state.codex.threads.find((item) => item.id === api.state.codex.activeThreadId), 'new thread');
      h.threadIds.push(thread.id);
      thread.title = `Interaction fixture ${suffix}`;
      thread.messages = [];
    }
    [h.roomA, h.roomB] = h.threadIds;
    // Keep send timing isolated from local file navigation. The v2 artifact
    // opens its verified file only in the later result-chip story.
    const card = h.must(api.cardRuntime.openBrowserCard('about:blank', { openMode: 'new' }), 'about:blank fixture Browser card');
    h.cardIds.push(card.id);
    h.resultCardId = card.id;
    const thread = api.state.codex.threads.find((item) => item.id === h.roomA);
    thread.messages = [
      { id: `${run}-assistant`, role: 'assistant', authorName: h.fixture.authorName,
        content: h.fixture.assistantText, status: 'complete', createdAt: 1700000000000,
        artifacts: [
          { id: `${run}-file`, type: 'file', status: 'available', relation: 'referenced',
            verifiedAt: 1700000000000, label: h.fixture.boundLabel, target: { path: fixtureFilePath } },
          { id: `${run}-unavailable`, type: 'file', status: 'unavailable', relation: 'referenced',
            verifiedAt: 1700000000000, label: h.fixture.unboundLabel, target: { path: fixtureFilePath } },
        ] },
      { id: `${run}-user`, role: 'user', authorName: h.fixture.userAuthorName,
        content: h.fixture.userText, status: 'complete', createdAt: 1700000060000, readBy: [] },
    ];
    if (!api.state.hudOpen || api.state.hudApp !== 'chat') {
      h.must(document.querySelector('.egd-dock-btn[data-id="chat"]'), 'chat dock button').click();
    }
    h.select(h.roomA);
    await h.frame();
    return { mounted: h.input().isConnected, roomCount: h.threadIds.length, resultCardId: card.id,
      resultUrl: card._xulBrowser?.getAttribute('src') || card.querySelector('.egd-card-url')?.value,
      fixture: h.fixture, runtimeProfile: api.codexBridge.threadRuntimeConfig(h.roomA).agentProfile?.id };
  }, { slot: SLOT, run: RUN, fixtureFilePath: FIXTURE_FILE_PATH, fixtureFileUrl: FIXTURE_FILE_URL }, false);
}

async function press(key) {
  const before = await evaluate(function () {
    const h = window.__egdeskChatInteractionTest;
    h.keyEvents = [];
    h.probeNode = h.input();
    h.probe = (event) => h.keyEvents.push({ key: event.key, trusted: event.isTrusted, composing: event.isComposing });
    h.probeNode.addEventListener('keydown', h.probe);
    return h.read();
  });
  let fallbackReason;
  let attemptedNative = false;
  try {
    if (!toolSchemas.get('press_key')?.properties?.uid || !toolSchemas.has('take_snapshot')) {
      fallbackReason = 'MCP has no UID-targeted key/snapshot schema';
    } else {
      const snapshot = resultText(await callTool('take_snapshot', {
        selector: '.egd-chat-card .egd-codex-input, #egd-hud:not(.egd-hud-hidden) .egd-codex-input',
        includeAttributes: true, maxLines: 30,
      }));
      const line = snapshot.split('\n').find((item) => /textarea|textbox|egd-codex-input/i.test(item));
      const uid = line?.match(/\buid\s*[=:]\s*["']?([^\s"'<>\[\],]+)/i)?.[1];
      if (!uid) fallbackReason = 'Chrome snapshot did not expose a composer UID';
      else {
        attemptedNative = true;
        await callTool('press_key', { key, uid });
      }
    }
  } catch (error) {
    if (attemptedNative) throw error; // A failed action may already have delivered input.
    fallbackReason = `UID acquisition unavailable: ${error.message}`;
  }
  return evaluate(async function ({ before, key, fallbackReason, attemptedNative }) {
    const h = window.__egdeskChatInteractionTest;
    await h.frame();
    h.probeNode.removeEventListener('keydown', h.probe);
    const nativeEvents = h.keyEvents.slice();
    const nativeAfter = h.read();
    if (attemptedNative && !nativeEvents.length && nativeAfter.value === before.value && nativeAfter.calls === before.calls) {
      fallbackReason = 'Native tool reported success but delivered no key to the mounted chrome composer';
    }
    let source = 'native-mcp-uid';
    if (fallbackReason) {
      source = 'synthetic-dom';
      const input = h.input();
      const options = { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true,
        ctrlKey: key.includes('ctrl+'), metaKey: key.includes('meta+') };
      const allowed = input.dispatchEvent(new KeyboardEvent('keydown', options));
      // dispatchEvent does not perform native textarea editing. Report this explicitly.
      if (key === 'Enter' && allowed && h.requests.length === before.calls && input.isConnected) {
        input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertLineBreak', data: null }));
      }
      input.dispatchEvent(new KeyboardEvent('keyup', options));
    }
    await h.frame();
    return { before, after: h.read(), source, fallbackReason: fallbackReason || null, nativeEvents,
      nativeDefaultEditingVerified: source === 'native-mcp-uid' && nativeEvents.some((event) => event.trusted) };
  }, { before, key, fallbackReason, attemptedNative });
}

async function sendStory(action) {
  const baseline = await evaluate(async function (action) {
    const h = window.__egdeskChatInteractionTest;
    h.finishMock();
    const text = `One ${action} submission from fixture A`;
    await h.type(text);
    const thread = h.api.state.codex.threads.find((item) => item.id === h.roomA);
    const clientThreadId = thread.clientBindingId || thread.id;
    h.sendPermit = { roomId: h.roomA, clientThreadId, message: text, profileEnabled: thread.profileEnabled === true };
    return { text, calls: h.requests.length, users: thread.messages.filter((item) => item.role === 'user').length,
      threadId: h.roomA, clientThreadId, profileEnabled: thread.profileEnabled === true,
      config: h.api.codexBridge.threadRuntimeConfig(h.roomA), before: h.read() };
  }, action);
  const input = action === 'click' ? await evaluate(async function () {
    const h = window.__egdeskChatInteractionTest;
    const button = h.must(h.root().querySelector('.egd-codex-send'), 'send button');
    if (button.disabled) {
      const { protocol, requests } = h.protocolRecords();
      const thread = h.api.state.codex.threads.find((item) => item.id === h.roomA);
      throw new Error(`Mounted send button disabled for nonempty draft: ${JSON.stringify({
        connected: h.api.state.codex.connected, loggedIn: h.api.state.codex.authStatus.isLoggedIn,
        isSending: h.api.state.codex.isSending, preparingInput: thread?.preparingInput,
        conversationId: thread?.conversationId, bindingState: thread?.bindingState,
        runs: h.chatState.runsForThread(protocol, thread).map((run) => ({ runId: run.runId, status: run.status })),
        requests: h.requests.map(({ body }) => h.raw(requests[body.requestId]))
          .filter((request) => request?.localThreadId === h.roomA)
          .map((request) => ({ requestId: request.requestId, status: request.status })),
      })}`);
    }
    button.click();
    await h.frame();
    return { source: 'mounted-button.click (synthetic)', after: h.read() };
  }) : await press(`${action}+Enter`);
  const after = await evaluate(async function (baseline) {
    const h = window.__egdeskChatInteractionTest;
    const started = performance.now();
    const inspect = () => {
      const codex = h.api.state.codex;
      const { protocol, requests, runs } = h.protocolRecords();
      const responseText = h.mockResponses[baseline.calls];
      const response = responseText ? JSON.parse(responseText) : null;
      const body = h.requests[baseline.calls]?.body || null;
      const request = response ? h.raw(requests[response.requestId]) : null;
      const runKey = response ? `${response.conversationId}/${response.runId}` : null;
      const thread = codex.threads.find((item) => item.id === h.roomA);
      const run = runKey ? h.raw(runs[runKey]) ||
        h.raw(h.chatState.runsForThread(protocol, thread).find((item) =>
          item.conversationId === response.conversationId && item.runId === response.runId)) : null;
      const bridgeRuns = h.raw(h.api.codexBridge.runState(h.roomA)) || [];
      const bridgeRun = response && Array.isArray(bridgeRuns) ? bridgeRuns.find((item) =>
        item.conversationId === response.conversationId && item.runId === response.runId) : null;
      return { response, runKey, request: request ? {
        requestId: request.requestId, clientThreadId: request.clientThreadId,
        conversationId: request.conversationId, runId: request.runId, status: request.status,
      } : null, run: run ? {
        requestId: run.requestId, clientThreadId: run.clientThreadId, localThreadId: run.localThreadId,
        conversationId: run.conversationId, runId: run.runId, status: run.status,
      } : null, thread: thread ? {
        id: thread.id, clientThreadId: thread.clientBindingId || thread.id,
        conversationId: thread.conversationId, bindingState: thread.bindingState,
        resuming: thread.resuming, preparingInput: thread.preparingInput, sendError: thread.sendError,
        submittedMessages: thread.messages.filter((message) => message.requestId === body?.requestId)
          .map((message) => ({ status: message.status, conversationId: message.conversationId, runId: message.runId })),
      } : null, bridgeRun: bridgeRun ? { requestId: bridgeRun.requestId,
        conversationId: bridgeRun.conversationId, runId: bridgeRun.runId, status: bridgeRun.status } : null,
      protocolLinkedToState: codex.chatProtocol === h.liveProtocol,
      accountKey: codex.codexAccountKey, fixtureAccountKey: h.chatState.codexAccountKey(codex.authStatus),
      connected: codex.connected, loggedIn: codex.authStatus.isLoggedIn,
      isSending: codex.isSending, pendingThreadId: codex.pendingThreadId,
      observedMockResponses: h.mockResponses.length, stateReads: h.stateReads, authWrites: h.authWrites,
      blocked: h.blocked.map(({ kind, path, method }) => ({ kind, path, method })),
      otherRuns: h.chatState.runsForThread(protocol, thread)
        .map((item) => ({ runId: item.runId, status: item.status })),
      otherRequests: h.requests.map(({ body: requestBody }) => h.raw(requests[requestBody.requestId]))
        .filter((item) => item?.localThreadId === h.roomA)
        .map((item) => ({ requestId: item.requestId, status: item.status })),
      };
    };
    let acceptance = inspect();
    // The mock fetch response may settle after the key action's animation
    // frames. Observe for at most 3s; never re-submit or synthesize acceptance.
    while (!(acceptance.run && acceptance.request?.status === 'accepted') && performance.now() - started < 3_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      acceptance = inspect();
    }
    await h.frame();
    acceptance = inspect();
    const thread = h.api.state.codex.threads.find((item) => item.id === h.roomA);
    return { calls: h.requests.length, users: thread.messages.filter((item) => item.role === 'user').length,
      requests: h.requests.slice(baseline.calls), response: acceptance.response,
      acceptedRun: acceptance.run, acceptedRequestStatus: acceptance.request?.status || null,
      acceptanceDiagnostics: { ...acceptance, waitedMs: Math.round(performance.now() - started),
        timedOut: !(acceptance.run && acceptance.request?.status === 'accepted') },
      permitConsumed: h.sendPermit === null, composer: h.read() };
  }, baseline);
  const body = after.requests[0]?.body;
  return { assertions: [
    check('exactly one intercepted submission', after.calls - baseline.calls === 1),
    check('exactly one own message appended', after.users - baseline.users === 1),
    check('v2 payload is this room and this exact draft', body?.clientThreadId === baseline.clientThreadId
      && body?.message === baseline.text && typeof body?.requestId === 'string' && after.permitConsumed),
    check('mock v2 acceptance binds the same request, room and run', after.response?.accepted === true
      && after.response.requestId === body?.requestId && after.response.clientThreadId === baseline.clientThreadId
      && after.acceptedRun?.requestId === body?.requestId
      && after.acceptedRun?.clientThreadId === baseline.clientThreadId
      && after.acceptedRun?.conversationId === after.response.conversationId
      && after.acceptedRun?.runId === after.response.runId && after.acceptedRequestStatus === 'accepted'),
    check('ordinary Codex omits persona fields; enabled profile carries exact runtime config',
      body?.profileEnabled === baseline.profileEnabled && (baseline.profileEnabled
        // A stored Agent Profile travels as its id and revision; the bridge composes it.
        ? (baseline.config.profileId
          ? body?.profileId === baseline.config.profileId && body?.profileRevision === baseline.config.profileRevision
            && !Object.hasOwn(body || {}, 'systemPrompt')
          : body?.agentProfile?.id === baseline.config.agentProfile?.id
            && body?.toolMode === baseline.config.toolMode && body?.systemPrompt === baseline.config.systemPrompt)
        : !Object.hasOwn(body || {}, 'agentProfile') && !Object.hasOwn(body || {}, 'toolMode')
          && !Object.hasOwn(body || {}, 'systemPrompt'))),
    check('sent draft clears and composer layout shrinks to 40px', after.composer.value === '' && after.composer.draft === ''
      && Math.abs(after.composer.height - 40) <= 1 && Math.abs(after.composer.cssHeight - 40) <= 1),
  ], action, source: input.source, fallbackReason: input.fallbackReason || null,
  before: { ...baseline.before, users: baseline.users }, after: { ...after.composer, users: after.users },
  acceptance: after.acceptanceDiagnostics,
  captured: after.requests.map(({ url, method, body: payload }) => ({ url, method,
    clientThreadId: payload.clientThreadId, requestId: payload.requestId, message: payload.message })) };
}

async function main() {
  await request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'egdesk-chat-interaction-regression', version: '1.0.0' } });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  toolSchemas = new Map((await request('tools/list')).tools.map((tool) => [tool.name, tool.inputSchema]));
  const contexts = resultText(await callTool('list_privileged_contexts'));
  context = contexts.match(/([0-9a-f-]{36})\s*:\s*chrome:\/\/browser\/content\/browser\.xhtml/i)?.[1];
  if (!context) throw new Error(`Firefox chrome context not found: ${contexts}`);
  await callTool('select_privileged_context', { contextId: context }, 120000);
  const guard = await evaluate(function () {
    const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
    return { profile: services.dirsvc.get('ProfD', Ci.nsIFile).path, mounted: Boolean(window.__egdesk?.codexBridge) };
  }, null, false);
  report('test-profile guard', [check('disposable profile path', guard.profile.includes('egdesk-chat-test-')),
    check('existing appboot API', guard.mounted)], guard);
  initialized = true; // Even partially completed setup must execute guarded cleanup.
  const fixture = await setup();
  fixtureReady = fixture.mounted === true;
  report('in-memory fixtures', [check('mounted composer', fixture.mounted),
    check('two isolated rooms', fixture.roomCount === 2),
    check('test-owned Browser card is about:blank', fixture.resultUrl === 'about:blank')], fixture);

  await story('composer autosize: one, six, overflow, one line', async () => {
    const sizes = await evaluate(async function () {
      const h = window.__egdeskChatInteractionTest;
      const one = await h.type('one line');
      const six = await h.type(['one', 'two', 'three', 'four', 'five', 'six'].join('\n'));
      const overflow = await h.type(Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n'));
      const shrunk = await h.type('one line again');
      return { one, six, overflow, shrunk };
    });
    // Canvas zoom changes the rendered rect, not textarea layout sizing.
    // Assert both clientHeight and computed CSS height; record visual scale separately.
    return { assertions: [
      check('one line layout starts at 40px', Math.abs(sizes.one.height - 40) <= 1
        && Math.abs(sizes.one.cssHeight - 40) <= 1),
      check('composer line height is 24px', sizes.six.lineHeight === 24),
      check('six lines grow, layout bounded to 40..144px', sizes.six.value.split('\n').length === 6
        && sizes.six.height > sizes.one.height && sizes.six.height >= 40 && sizes.six.height <= 145
        && sizes.six.cssHeight > sizes.one.cssHeight && sizes.six.cssHeight >= 40 && sizes.six.cssHeight <= 145),
      check('layout overflow caps at 144px and scrolls', Math.abs(sizes.overflow.height - 144) <= 1
        && Math.abs(sizes.overflow.cssHeight - 144) <= 1
        && sizes.overflow.scrollHeight > sizes.overflow.clientHeight && sizes.overflow.overflowY === 'auto'),
      check('deleting lines shrinks layout to 40px', Math.abs(sizes.shrunk.height - 40) <= 1
        && Math.abs(sizes.shrunk.cssHeight - 40) <= 1),
      check('input alone never submits', sizes.one.calls === sizes.shrunk.calls),
    ], source: 'synthetic input on mounted textarea', sizes };
  });

  await story('Enter inserts newline without submitting', async () => {
    await evaluate(async function () { return window.__egdeskChatInteractionTest.type('Enter keeps this draft'); });
    const result = await press('Enter');
    return { assertions: [
      check('no submission', result.after.calls === result.before.calls),
      check('newline inserted at selection', result.after.value === `${result.before.value}\n`),
      check('room draft tracks textarea', result.after.draft === result.after.value),
    ], ...result };
  });

  for (const action of ['ctrl', 'meta', 'click']) {
    await story(`${action} send submits once`, () => sendStory(action));
  }

  await story('IME composition cannot submit', async () => {
    const result = await evaluate(async function () {
      const h = window.__egdeskChatInteractionTest;
      h.finishMock();
      await h.type('조합 중인 초안');
      const input = h.input();
      const before = h.read();
      const counts = [];
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '조합' }));
      for (const modifier of ['ctrlKey', 'metaKey']) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter',
          [modifier]: true, isComposing: true, bubbles: true, cancelable: true }));
        counts.push(h.requests.length);
      }
      // Also covers engines where the local composition flag is the only signal.
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
      h.root().querySelector('.egd-codex-send').click();
      counts.push(h.requests.length);
      input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '조합' }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, keyCode: 229,
        bubbles: true, cancelable: true }));
      counts.push(h.requests.length);
      await h.frame();
      return { before, after: h.read(), counts };
    });
    return { assertions: [
      check('composing ctrl/meta Enter, local composition flag, click and keyCode229 do not send',
        result.counts.every((count) => count === result.before.calls) && result.after.calls === result.before.calls),
      check('composition draft remains intact', result.after.value === result.before.value && result.after.draft === result.before.value),
    ], source: 'synthetic KeyboardEvent/CompositionEvent; not an OS IME test', ...result };
  });

  await story('bridge rerender preserves drafting; rooms own separate drafts', async () => {
    const result = await evaluate(async function () {
      const h = window.__egdeskChatInteractionTest;
      h.finishMock();
      h.select(h.roomA);
      await h.type('Room A draft\nkeep selection and focus');
      const oldInput = h.input();
      oldInput.setSelectionRange(7, 18, 'backward');
      const before = h.read();
      const thread = h.api.state.codex.threads.find((item) => item.id === h.roomA);
      thread.messages.push({ id: `${h.run}-live`, role: 'assistant', authorName: h.fixture.authorName,
        content: 'Live fixture bridge update', status: 'streaming', createdAt: 1700000120000 });
      h.auth();
      h.api.codexBridge.selectThread(h.roomA, { openConversation: true }); // Real subscribe/render path, no remount.
      await h.frame();
      const after = h.read();
      const oldInputReplaced = h.input() !== oldInput;
      const liveVisible = h.messages().textContent.includes('Live fixture bridge update');
      h.select(h.roomB);
      await h.frame();
      const emptyB = h.read();
      const draftedB = await h.type('Room B independent draft');
      h.select(h.roomA);
      await h.frame();
      const restoredA = h.read();
      h.select(h.roomB);
      await h.frame();
      const restoredB = h.read();
      h.select(h.roomA);
      await h.frame();
      return { before, after, oldInputReplaced, liveVisible,
        emptyB, draftedB, restoredA, restoredB };
    });
    return { assertions: [
      check('bridge update actually reaches mounted log', result.liveVisible),
      check('rerender preserves focus, selection, direction and value', result.after.focused
        && result.after.start === result.before.start && result.after.end === result.before.end
        && result.after.direction === result.before.direction && result.after.value === result.before.value),
      check('room B initially has no room A draft', result.emptyB.value === '' && result.emptyB.draft === ''),
      check('room A draft restores', result.restoredA.value === result.before.value && result.restoredA.draft === result.before.value),
      check('room B draft restores independently', result.restoredB.value === result.draftedB.value
        && result.restoredB.draft === result.draftedB.value && result.restoredA.threadId !== result.restoredB.threadId),
      check('rerender and room switching never submit', result.restoredB.calls === result.before.calls),
    ], source: 'in-memory live message + existing codexBridge.selectThread emission', ...result };
  });

  await story('own bubble right; fixture author left; no header profile chips', async () => {
    const geometry = await evaluate(async function () {
      const h = window.__egdeskChatInteractionTest;
      h.messages().scrollTop = 0;
      await h.frame();
      const rows = [...h.messages().querySelectorAll('.egd-codex-message-row')];
      const own = h.must(rows.find((row) => row.querySelector('.egd-codex-bubble-content')?.textContent === h.fixture.userText), 'fixture own row');
      const assistant = h.must(rows.find((row) => row.querySelector('.egd-codex-bubble-content')?.textContent === h.fixture.assistantText), 'fixture assistant row');
      const label = h.must(assistant.querySelector('.egd-codex-message-role'), 'fixture author label');
      const header = h.must(h.root().querySelector('.egd-codex-conversation-hud-head, .egd-codex-thread-active-head'), 'conversation header');
      return { ownRow: h.rect(own), ownBubble: h.rect(own.querySelector('.egd-codex-bubble')),
        assistantRow: h.rect(assistant), assistantBubble: h.rect(assistant.querySelector('.egd-codex-bubble')),
        ownFontSize: parseFloat(getComputedStyle(own.querySelector('.egd-codex-bubble-content')).fontSize),
        assistantFontSize: parseFloat(getComputedStyle(assistant.querySelector('.egd-codex-bubble-content')).fontSize),
        author: { text: label.textContent.trim(), expected: h.fixture.authorName, rect: h.rect(label) },
        profileChips: header.querySelectorAll('.egd-codex-agent-profile-chip, .egd-codex-tool-mode-chip').length };
    });
    return { assertions: [
      check('own bubble is visibly right aligned', geometry.ownBubble.width > 0
        && Math.abs(geometry.ownRow.right - geometry.ownBubble.right) <= 2
        && geometry.ownBubble.left > geometry.assistantBubble.left),
      check('fixture author is named on the left', geometry.author.text === geometry.author.expected
        && geometry.author.rect.width > 0 && geometry.author.rect.left < (geometry.assistantRow.left + geometry.assistantRow.right) / 2),
      check('header contains no runtime-profile/tool chips', geometry.profileChips === 0),
      check('own and assistant text both use approved 12px type', geometry.ownFontSize === 12 && geometry.assistantFontSize === 12),
    ], geometry };
  });

  await story('verified file result opens only its local card; unavailable result is suppressed', async () => {
    const result = await evaluate(async function () {
      const h = window.__egdeskChatInteractionTest;
      const chips = [...h.root().querySelectorAll('.egd-codex-result-chip')];
      const find = (label) => chips.find((chip) => chip.querySelector('.egd-codex-result-label')?.textContent === label);
      const bound = h.must(find(h.fixture.boundLabel), 'verified fixture file chip');
      const unavailable = find(h.fixture.unboundLabel);
      const thread = h.must(h.api.state.codex.threads.find((item) => item.id === h.roomA), 'fixture room A');
      const assistant = h.must(thread.messages.find((item) => item.id === `${h.run}-assistant`), 'fixture assistant message');
      const storedUnavailable = assistant.artifacts?.find((item) => item.label === h.fixture.unboundLabel);
      const cardIds = () => [...document.querySelectorAll('.egd-canvas-card')].map((card) => card.id).sort();
      const fixtureFileCards = () => [...document.querySelectorAll('.egd-browser-card')].filter((card) =>
        card._xulBrowser?.getAttribute('src') === h.fixture.fileUrl || card.querySelector('.egd-card-url')?.value === h.fixture.fileUrl);
      if (fixtureFileCards().length) throw new Error('REFUSED pre-existing fixture file Browser card');
      const before = { ids: cardIds(), active: h.api.state.activeEntityId, calls: h.requests.length };
      // Start with no card selected so a no-op link cannot pass merely by coincidence.
      document.getElementById('egd-canvas-viewport').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, cancelable: true }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
      const deselected = h.api.state.activeEntityId;
      bound.click();
      const focused = h.api.state.activeEntityId;
      const openedIds = cardIds().filter((id) => !before.ids.includes(id));
      const openedCard = openedIds.length === 1 ? document.getElementById(openedIds[0]) : null;
      const openedUrl = openedCard?._xulBrowser?.getAttribute('src') || openedCard?.querySelector('.egd-card-url')?.value || null;
      if (openedCard) {
        h.cardIds.push(openedCard.id);
        await h.api.cardRuntime.closeCard(openedCard);
        await h.frame();
      }
      return { before, deselected, focused, openedIds, openedUrl, boundDisabled: bound.disabled,
        boundArtifactId: bound.dataset.artifactId, boundTitle: bound.title,
        unavailableRendered: Boolean(unavailable), storedUnavailableStatus: storedUnavailable?.status,
        after: { ids: cardIds(), active: h.api.state.activeEntityId, calls: h.requests.length } };
    });
    return { assertions: [
      check('verified file chip opens and focuses exactly one local card', !result.boundDisabled && result.deselected === null
        && result.openedIds.length === 1 && result.focused === result.openedIds[0]
        && result.openedUrl === FIXTURE_FILE_URL && result.boundArtifactId === `${RUN}-file`
        && result.boundTitle.includes(FIXTURE_FILE_PATH)),
      check('unavailable fixture artifact is stored but not actionable', result.storedUnavailableStatus === 'unavailable'
        && !result.unavailableRendered),
      check('only test-owned result card is closed; no submission', JSON.stringify(result.before.ids) === JSON.stringify(result.after.ids)
        && result.before.calls === result.after.calls),
    ], source: 'mounted button.click (synthetic)', ...result };
  });

  await story('one resource gadget survives fixture Browser focus and ordinary close', async () => {
    const result = await evaluate(async function () {
      const h = window.__egdeskChatInteractionTest;
      const card = h.must(document.getElementById(h.resultCardId), 'fixture Browser card');
      const gadget = h.must(document.querySelector('.egd-resource-gadget'), 'resource gadget');
      const count = () => document.querySelectorAll('.egd-resource-gadget').length;
      const originalFocusId = h.api.state.cardFullscreen?.cardId || null;
      const originalFocus = originalFocusId ? document.getElementById(originalFocusId) : null;
      if (originalFocusId && (!originalFocus || !originalFocus.classList.contains('egd-browser-card'))) {
        throw new Error('REFUSED to replace an unrelated fullscreen card');
      }
      const before = { count: count(), connected: gadget.isConnected, cardId: card.id, originalFocusId };
      // Preserve an already-focused, non-fixture Browser. Only maximize the
      // test-owned Browser when no other card owns fullscreen presentation.
      if (!originalFocus) h.must(card.querySelector('.egd-desk-window-control[title="창 최대화"]'), 'fixture Browser maximize control').click();
      await h.frame();
      const focusedCard = originalFocus || card;
      const toolbar = h.must(focusedCard.querySelector('.egd-desk-window-toolbar'), 'focused Browser toolbar');
      const focused = { count: count(), sameNode: document.querySelector('.egd-resource-gadget') === gadget,
        inToolbar: gadget.parentElement === toolbar, fullscreenCardId: h.api.state.cardFullscreen?.cardId };
      h.must(card.querySelector('.egd-desk-window-control[title="창 닫기"]'), 'fixture Browser close control').click();
      await h.frame();
      const railRight = h.must(document.querySelector('#egd-desk-rail .egd-rail-right'), 'Desk rail');
      const closed = { count: count(), sameNode: document.querySelector('.egd-resource-gadget') === gadget,
        inExpectedHost: gadget.parentElement === (originalFocus ? toolbar : railRight), connected: gadget.isConnected,
        cardRemoved: !card.isConnected, fullscreenCardId: h.api.state.cardFullscreen?.cardId || null };
      return { before, focused, closed };
    });
    return { assertions: [
      check('one connected gadget exists before fixture Browser focus', result.before.count === 1 && result.before.connected),
      check('same single gadget is in focused Browser toolbar', result.focused.count === 1
        && result.focused.sameNode && result.focused.inToolbar
        && result.focused.fullscreenCardId === (result.before.originalFocusId || result.before.cardId)),
      check('ordinary fixture Browser close preserves one gadget in the correct host', result.closed.count === 1
        && result.closed.sameNode && result.closed.inExpectedHost && result.closed.connected
        && result.closed.cardRemoved && result.closed.fullscreenCardId === result.before.originalFocusId),
    ], source: 'mounted controls on test-owned local-file Browser card', ...result };
  });

  await story('canvas chat: boundary wheel, blank deselect, hover, same-session wheel', async () => {
    const result = await evaluate(async function () {
      const h = window.__egdeskChatInteractionTest;
      h.must(document.querySelector('#egd-hud .egd-hud-pin'), 'move-to-canvas button').click();
      const card = h.must(document.getElementById(h.api.state.codex.chatCardEntityId), 'detached chat card');
      h.cardIds.push(card.id);
      h.chatCardId = card.id;
      h.must(document.querySelector('.egd-dock-btn[data-id="select"]'), 'selection tool').click();
      const thread = h.api.state.codex.threads.find((item) => item.id === h.roomA);
      thread.messages.push(...Array.from({ length: 30 }, (_, i) => ({ id: `${h.run}-scroll-${i}`,
        role: i % 2 ? 'user' : 'assistant', authorName: i % 2 ? h.fixture.userAuthorName : h.fixture.authorName,
        content: `Fixture scroll row ${i + 1}`, status: 'complete', createdAt: 1700000300000 + i * 180000 })));
      h.select(h.roomA);
      await h.frame();
      const viewport = h.must(document.getElementById('egd-canvas-viewport'), 'blank canvas');
      const layer = document.getElementById('egd-canvas-layer');
      const scanForBlankCanvas = () => {
        for (let y = 90; y < window.innerHeight - 100; y += 35) {
          for (let x = 25; x < window.innerWidth - 25; x += 35) {
            const target = document.elementFromPoint(x, y);
            if (target === viewport || target === layer) return { x, y, target };
          }
        }
        return null;
      };
      const maxZoomOutClicks = 10;
      const zoomOut = h.must(document.querySelector('#egd-zoom-indicator button[aria-label="Canvas 축소"]'),
        'Canvas zoom-out control');
      let blank = scanForBlankCanvas();
      let zoomOutClicks = 0;
      while (!blank && zoomOutClicks < maxZoomOutClicks) {
        const previousZoom = h.api.state.zoomTarget;
        zoomOut.click();
        zoomOutClicks++;
        await h.frame();
        if (!(h.api.state.zoomTarget < previousZoom)) {
          throw new Error(`Canvas zoom-out control did not lower camera zoom (click ${zoomOutClicks})`);
        }
        blank = scanForBlankCanvas();
      }
      if (!blank) throw new Error('No genuinely blank visible canvas point; cannot test deselection');
      // Expire any older wheel session before the new boundary gesture. The actual
      // boundary -> blank mousedown -> hover -> wheel sequence below has NO await.
      await new Promise((resolve) => setTimeout(resolve, 180));
      const mountedMessages = () => {
        const log = h.messages();
        if (!log.isConnected || !card.contains(log)) throw new Error('Chat message log is not mounted in the active Canvas card');
        return log;
      };
      h.input().focus({ preventScroll: true });
      const messages = mountedMessages();
      messages.scrollTop = messages.scrollHeight;
      if (messages.clientHeight <= 0 || messages.scrollHeight <= messages.clientHeight) {
        throw new Error(`Mounted Chat log is not scrollable: ${JSON.stringify({
          connected: messages.isConnected, clientHeight: messages.clientHeight, scrollHeight: messages.scrollHeight,
        })}`);
      }
      const wheel = () => {
        const log = mountedMessages();
        const center = h.rect(log);
        log.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
          deltaMode: 0, deltaY: 72, deltaX: 0, clientX: (center.left + center.right) / 2,
          clientY: (center.top + center.bottom) / 2 }));
      };
      const before = { camera: h.camera(), active: h.api.state.activeEntityId, focused: document.activeElement === h.input(),
        scrollTop: messages.scrollTop, clientHeight: messages.clientHeight, scrollHeight: messages.scrollHeight };
      const began = performance.now();
      wheel();
      const boundary = { camera: h.camera(), active: h.api.state.activeEntityId, scrollTop: mountedMessages().scrollTop };
      blank.target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0,
        clientX: blank.x, clientY: blank.y }));
      window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0, clientX: blank.x, clientY: blank.y }));
      const deselected = { active: h.api.state.activeEntityId, focused: document.activeElement === h.input(),
        selected: card.classList.contains('egd-entity-selected'), camera: h.camera() };
      for (const kind of ['card', 'messages']) {
        for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
          const target = kind === 'card' ? card : mountedMessages();
          const center = h.rect(target);
          const EventType = type.startsWith('pointer') ? PointerEvent : MouseEvent;
          target.dispatchEvent(new EventType(type, { bubbles: !type.endsWith('enter'),
            clientX: (center.left + center.right) / 2, clientY: (center.top + center.bottom) / 2 }));
        }
      }
      const hovered = { active: h.api.state.activeEntityId, focused: document.activeElement === h.input() };
      const gapMs = performance.now() - began;
      wheel();
      const inactive = { camera: h.camera(), active: h.api.state.activeEntityId, focused: document.activeElement === h.input() };
      await new Promise((resolve) => setTimeout(resolve, 100));
      return { chatCardId: card.id, before, boundary, deselected, hovered, inactive, settledCamera: h.camera(),
        gapMs, blank: { x: blank.x, y: blank.y, targetId: blank.target.id }, zoomOutClicks, maxZoomOutClicks };
    });
    const sameTarget = (a, b) => a.target.x === b.target.x && a.target.y === b.target.y && a.zoom === b.zoom;
    return { assertions: [
      check('chat starts active, focused and scrollable at bottom', result.before.active === result.chatCardId && result.before.focused
        && result.before.scrollHeight > result.before.clientHeight
        && result.before.scrollHeight - result.before.clientHeight - result.before.scrollTop <= 2),
      check('active chat boundary wheel never pans canvas', sameTarget(result.before.camera, result.boundary.camera)),
      check('blank mousedown deselects and blurs composer', result.deselected.active === null && !result.deselected.focused && !result.deselected.selected),
      check('blank hit is the Canvas viewport/layer after bounded real-control zoom-out',
        ['egd-canvas-viewport', 'egd-canvas-layer'].includes(result.blank.targetId)
          && result.zoomOutClicks <= result.maxZoomOutClicks),
      check('hover never activates or focuses chat', result.hovered.active === null && !result.hovered.focused),
      check('next wheel occurs inside prior 140ms session', result.gapMs < 140),
      check('inactive chat wheel immediately pans camera target', !sameTarget(result.deselected.camera, result.inactive.camera)
        && result.inactive.camera.zoom === result.deselected.camera.zoom),
      check('camera actually moves, not only its target', result.settledCamera.pan.y !== result.deselected.camera.pan.y),
      check('inactive wheel does not reactivate input', result.inactive.active === null && !result.inactive.focused),
    ], source: 'synthetic DOM mouse/pointer/wheel on mounted UI; same-task wheel session', ...result };
  });

  const visualStory = await story('canvas to HUD to canvas preserves one room draft without sending', async () => {
    const result = await evaluate(async function () {
      const h = window.__egdeskChatInteractionTest;
      h.finishMock();
      h.select(h.roomA);
      await h.frame();
      const firstCardId = h.api.state.codex.chatCardEntityId;
      const firstCard = h.must(document.getElementById(firstCardId), 'canvas chat card');
      const thread = h.must(h.api.state.codex.threads.find((item) => item.id === h.roomA), 'fixture room A');
      const messageCount = thread.messages.length;
      const draft = 'Keep this exact fixture draft across Canvas and HUD';
      const first = await h.type(draft);
      h.must(firstCard.querySelector('button[title="우측 패널로 이동"]'), 'move-to-HUD button').click();
      await h.frame();
      const hud = { ...h.read(), dockMode: h.api.state.codex.chatDockMode,
        open: h.api.state.hudOpen, app: h.api.state.hudApp,
        cardId: h.api.state.codex.chatCardEntityId, roomId: h.api.state.codex.activeThreadId };
      h.must(document.querySelector('#egd-hud .egd-hud-pin'), 'move-to-canvas button').click();
      await h.frame();
      const secondCardId = h.api.state.codex.chatCardEntityId;
      if (secondCardId && !h.cardIds.includes(secondCardId)) h.cardIds.push(secondCardId);
      const second = { ...h.read(), dockMode: h.api.state.codex.chatDockMode,
        cardId: secondCardId, cardConnected: Boolean(document.getElementById(secondCardId)),
        roomId: h.api.state.codex.activeThreadId,
        messageCount: h.api.state.codex.threads.find((item) => item.id === h.roomA)?.messages.length };
      return { draft, roomId: h.roomA, firstCardId, firstCardRemoved: !firstCard.isConnected,
        messageCount, first, hud, second };
    });
    return { assertions: [
      check('Canvas moves to the mounted HUD for the same room', result.firstCardRemoved
        && result.hud.dockMode === 'hud' && result.hud.open && result.hud.app === 'chat'
        && result.hud.cardId === null && result.hud.roomId === result.roomId),
      check('HUD returns to a mounted Canvas chat for the same room', result.second.dockMode === 'canvas'
        && result.second.cardConnected && result.second.cardId !== result.firstCardId
        && result.second.roomId === result.roomId),
      check('exact room draft survives both moves', result.first.value === result.draft
        && result.hud.value === result.draft && result.hud.draft === result.draft
        && result.second.value === result.draft && result.second.draft === result.draft
        && result.first.threadId === result.hud.threadId && result.hud.threadId === result.second.threadId),
      check('moving the same draft adds no message or submission', result.second.messageCount === result.messageCount
        && result.first.calls === result.hud.calls && result.hud.calls === result.second.calls),
    ], source: 'mounted Canvas/HUD buttons and one in-memory fixture draft', ...result };
  });
  visualFixtureReady = visualStory.ok;
}

async function cleanup() {
  if (!initialized || !context) return;
  const result = await evaluate(function ({ slot, run }) {
    const h = window[slot];
    if (!h) return { skipped: true, errors: [] };
    if (h.run !== run) throw new Error('Refused cleanup of another test owner');
    const errors = [];
    const safely = (label, fn) => { try { fn(); } catch (error) { errors.push(`${label}: ${error.message}`); } };
    const captured = h.requests.map(({ method, body }) => ({ method,
      clientThreadId: body.clientThreadId, requestId: body.requestId, message: body.message }));
    try {
      safely('key probe', () => h.probeNode?.removeEventListener('keydown', h.probe));
      // A partial detach may have thrown before tracking the new chat card.
      const currentChat = h.api.state.codex.chatCardEntityId;
      if (currentChat && currentChat !== h.savedCodex.chatCardEntityId && !h.cardIds.includes(currentChat)) h.cardIds.push(currentChat);
      for (const id of [...h.cardIds].reverse()) {
        safely(`close ${id}`, () => { const card = document.getElementById(id); if (card) h.api.cardRuntime.closeCard(card); });
      }
      safely('restore auth descriptor', () => h.restoreAuth?.());
      safely('restore in-memory rooms/auth/drafts', () => {
        // The mounted bridge closes over this exact protocol object. Restore its
        // contents in place; swapping in the JSON copy breaks the next run.
        for (const key of Object.keys(h.savedCodex)) {
          if (key !== 'chatProtocol') h.api.state.codex[key] = h.savedCodex[key];
        }
        h.api.state.codex.chatProtocol = h.liveProtocol;
        for (const key of Object.keys(h.liveProtocol)) delete h.liveProtocol[key];
        Object.assign(h.liveProtocol, h.clone(h.savedCodex.chatProtocol));
      });
      safely('restore HUD through its controls', () => {
        if (!h.savedHud.open && h.api.state.hudOpen) document.querySelector('.egd-hud-close')?.click();
        if (h.savedHud.open && (!h.api.state.hudOpen || h.api.state.hudApp !== h.savedHud.app)) {
          document.querySelector(`.egd-dock-btn[data-id="${h.savedHud.app}"]`)?.click();
        }
        if (h.api.state.hudOpen && h.api.state.hudApp === 'chat') {
          h.api.codexBridge.setHudView(h.savedCodex.hudView);
        } else if (!h.api.state.hudOpen) {
          // Closing HUD unsubscribes Chat but leaves its last render in the hidden body.
          document.getElementById('egd-hud-body')?.replaceChildren();
        }
      });
      safely('restore camera', () => h.api.state.setCanvasViewportTarget(h.savedCamera, { immediate: true }));
      safely('restore selection/tool', () => {
        document.querySelector(`.egd-dock-btn[data-id="${h.savedTool}"]`)?.click();
        const previous = document.getElementById(h.savedActive);
        if (previous) h.api.cardRuntime.focusCard(previous);
        if (h.originalFocus?.isConnected) h.originalFocus.focus?.({ preventScroll: true });
      });
    } finally {
      window.fetch = h.originalFetch;
      window.EventSource = h.originalEventSource;
      Object.assign(h.api.state.agenda, h.savedAgenda);
      delete window[slot];
      // Let the existing bridge reconnect normally after removing our no-op source.
      // This restores its transport without remounting or replacing app listeners.
      for (const source of h.mockSources) {
        safely('release mock EventSource', () => {
          source.close();
          source.onerror?.(new Event('error'));
        });
      }
    }
    const hud = document.getElementById('egd-hud');
    const hudBody = document.getElementById('egd-hud-body');
    const fixtureDomRemaining = Boolean(hudBody && (
      [...hudBody.querySelectorAll('[data-thread-id]')].some((node) => h.threadIds.includes(node.dataset.threadId)) ||
      [...hudBody.querySelectorAll('[data-message-id]')].some((node) => node.dataset.messageId?.startsWith(h.run))
    ));
    return { errors, captured, blocked: h.blocked, stateReads: h.stateReads, authWrites: h.authWrites,
      fetchRestored: window.fetch === h.originalFetch, eventSourceRestored: window.EventSource === h.originalEventSource,
      remainingCards: h.cardIds.filter((id) => document.getElementById(id)),
      remainingThreads: h.api.state.codex.threads.filter((thread) => h.threadIds.includes(thread.id)).map((thread) => thread.id),
      authRestored: JSON.stringify(h.api.state.codex.authStatus) === JSON.stringify(h.savedCodex.authStatus),
      protocolIdentityRestored: h.api.state.codex.chatProtocol === h.liveProtocol,
      fixtureProtocolRemaining: h.requests.some(({ body }) => Object.hasOwn(h.liveProtocol.requests, body.requestId))
        || h.mockRunIds.some((runId, index) => Object.hasOwn(h.liveProtocol.runs, `${h.mockConversationIds[index]}/${runId}`)),
      hudRestored: h.api.state.hudOpen === h.savedHud.open && h.api.state.hudApp === h.savedHud.app
        && hud?.classList.contains('egd-hud-hidden') === !h.savedHud.open,
      fixtureDomRemaining,
      firefoxShutdownRequested: false };
  }, { slot: SLOT, run: RUN }, false);
  report('cleanup and network safety', [check('cleanup completes', result.errors.length === 0),
    check('fetch restored', result.skipped || result.fetchRestored),
    check('EventSource restored', result.skipped || result.eventSourceRestored),
    check('only test-created cards and rooms removed', result.skipped || (!result.remainingCards.length && !result.remainingThreads.length)),
    check('original in-memory auth restored', result.skipped || result.authRestored),
    check('bridge protocol identity restored without fixture requests or runs', result.skipped
      || (result.protocolIdentityRestored && !result.fixtureProtocolRemaining)),
    check('original HUD open/app state restored', result.skipped || result.hudRestored),
    check('no fixture Chat DOM remains in HUD', result.skipped || !result.fixtureDomRemaining),
    check('no unexpected send or chat action attempted', result.skipped || result.blocked.length === 0),
  ], result);
}

try {
  await main();
} catch (error) {
  report('harness', [check('execution completed', false)], { error: error.stack || error.message });
} finally {
  if (fixtureReady && visualFixtureReady) {
    console.log(JSON.stringify({ story: 'fixtureReady', status: 'ready for visual capture', holdMs: VISUAL_HOLD_MS }));
    if (VISUAL_HOLD_MS > 0) await new Promise((resolve) => setTimeout(resolve, VISUAL_HOLD_MS));
  }
  if (initialized && SCREENSHOT !== '-') {
    try {
      await evaluate(function () { return Boolean(window.__egdesk); }, null, false);
      const shot = resultText(await callTool('screenshot_page', { saveTo: SCREENSHOT }));
      screenshotPath = shot.match(/(\/[^\n"`]*\.(?:png|jpe?g|webp))/i)?.[1] || null;
      console.log(JSON.stringify({ story: 'optional screenshot before cleanup', path: screenshotPath, result: shot }));
    } catch (error) {
      console.log(JSON.stringify({ story: 'optional screenshot unavailable', error: error.message }));
    }
  }
  try { await cleanup(); } catch (error) {
    report('cleanup', [check('cleanup completed', false)], { error: error.message,
      action: 'Inspect/discard the disposable profile; Firefox was not stopped.' });
  }
  const failures = events.flatMap((event) => event.assertions.filter((item) => !item.ok).map((item) => `${event.story}: ${item.assertion}`));
  console.log(JSON.stringify({ test: 'firefox-mcp-chat-interaction', ok: !failures.length,
    stories: events.length, assertions: events.reduce((sum, event) => sum + event.assertions.length, 0), failures,
    screenshot: screenshotPath }));
  if (failures.length) {
    process.exitCode = 1;
    if (stderr.trim()) console.error(stderr.trim());
  }
  proc.stdin.end();
  // Terminate only this spawned MCP transport if stdin EOF does not end it.
  // Never invoke a Firefox close/restart/kill API or signal a browser process.
  const timer = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM'); }, 1000);
  timer.unref();
}
