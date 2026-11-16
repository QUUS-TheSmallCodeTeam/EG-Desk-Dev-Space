#!/usr/bin/env node
// Attach-only, model-free check of the real Firefox iframe -> chrome message
// boundary. Main owns the isolated Firefox and loopback fixture lifecycles.
// No shell commands are sent. --retry clicks the existing reconnect UI;
// the caller's isolated fixture owns any session that this may reconnect.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FirefoxMcpChatHarness, waitUntil } from './firefox-mcp-chat-harness.mjs';
import { assertQaProfileBridge, qaBridgeConfig } from './egdesk-qa-fixture-isolation.mjs';
import { captureHeadlessScreenshot } from './verify-firefox-mcp-headless-ui-regression.mjs';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i], value = process.argv[i + 1];
  assert.ok(['--profile', '--expect', '--retry'].includes(key) && value && !args.has(key),
    'usage: --profile OWNED_QA_PROFILE --expect failed|connected|disconnected [--retry 1]');
  args.set(key, value);
}
const profile = args.get('--profile'), expected = args.get('--expect');
assert.ok(profile && ['failed', 'connected', 'disconnected'].includes(expected));
assert.ok(!args.has('--retry') || args.get('--retry') === '1');
assert.equal(process.env.EGDESK_QA_REAL_TURN, '0', 'explicit model-free QA is required');
assert.equal(qaBridgeConfig().fixture, true, 'never attach to the production helper');
assertQaProfileBridge(profile);
const harness = new FirefoxMcpChatHarness({ profile });
const read = () => harness.evaluateChrome(`() => {
  const card = document.querySelector('.egd-terminal-card'), frame = card?.querySelector('iframe');
  const api = frame?.contentWindow?.terminalAPI;
  return { count: document.querySelectorAll('.egd-terminal-card').length,
    header: card?.querySelector('.egd-terminal-session')?.textContent,
    shell: frame?.contentDocument?.getElementById('terminal-shell-label')?.textContent,
    status: frame?.contentDocument?.getElementById('status-overlay')?.textContent,
    connected: api?.isConnected?.() === true,
    sessionLabel: api?.sessionInfo?.()?.shellLabel,
    randomUuidAvailable: typeof frame?.contentWindow?.crypto?.randomUUID === 'function',
    documentKeyVisible: typeof api?.hostEventKey === 'string' && !!api.hostEventKey,
    events: window.__egdeskTerminalStatusQa?.events || [],
    transitions: window.__egdeskTerminalStatusQa?.transitions || [] };
}`);
const matches = value => value.count === 1 && (expected === 'connected'
  ? value.connected && !!value.sessionLabel && value.header === value.sessionLabel
    && (value.shell === value.sessionLabel || value.shell.startsWith(value.sessionLabel + ' · '))
  : expected === 'failed' ? !value.connected && value.header === '연결 실패' && value.shell === '연결 실패'
    : !value.connected && value.header === '연결 끊김');
let installed = false;
try {
  await harness.connect();
  assert.equal((await read()).count, 1, 'prepare exactly one Terminal in the owned profile first');
  await harness.snapshot('.egd-terminal-card');
  await harness.evaluateChrome(`() => {
    if (window.__egdeskTerminalStatusQa) throw new Error('Another status observer is active');
    const header = document.querySelector('.egd-terminal-session');
    const qa = { events: [], transitions: [header.textContent] };
    qa.onMessage = event => {
      if (typeof event.data?.type !== 'string' || !event.data.type.startsWith('terminal-')) return;
      const frame = document.querySelector('.egd-terminal-card iframe');
      qa.events.push({ type: event.data.type, sourceIsNull: event.source === null,
        origin: event.origin, keyMatches: !!event.data.hostEventKey
          && event.data.hostEventKey === frame?.contentWindow?.terminalAPI?.hostEventKey });
    };
    qa.observer = new MutationObserver(() => {
      if (qa.transitions.at(-1) !== header.textContent) qa.transitions.push(header.textContent);
    });
    qa.observer.observe(header, { childList: true, characterData: true, subtree: true });
    window.addEventListener('message', qa.onMessage);
    window.__egdeskTerminalStatusQa = qa;
    return { observing: true };
  }`);
  installed = true;
  if (args.has('--retry')) {
    // Native pointer input at the observed retry text, not a synthetic click or
    // a direct call into the terminal API. Account for Canvas scale on the frame.
    const point = await harness.evaluateChrome(`() => {
      const frame = document.querySelector('.egd-terminal-card iframe');
      const status = frame?.contentDocument?.getElementById('status-overlay');
      const text = status?.firstChild;
      if (!text || text.nodeType !== 3 || status.classList.contains('hidden')) throw new Error('No visible retry text');
      const range = status.ownerDocument.createRange(); range.selectNodeContents(text);
      const rect = range.getBoundingClientRect(), outer = frame.getBoundingClientRect();
      const innerX = rect.x + rect.width / 2, innerY = rect.y + rect.height / 2;
      const hit = status.ownerDocument.elementFromPoint(innerX, innerY);
      if (!status.contains(hit) || hit.closest('details')) throw new Error('Retry text is obscured');
      const x = outer.x + innerX * outer.width / frame.clientWidth;
      const y = outer.y + innerY * outer.height / frame.clientHeight;
      if (document.elementFromPoint(x, y) !== frame) throw new Error('Terminal frame is obscured');
      return { x, y };
    }`);
    await harness.clickPoint(point);
  }
  const outcome = expected === 'connected' ? 'terminal-ready' : 'terminal-disconnected';
  const retryObserved = value => !args.has('--retry') || (value.transitions.includes('연결 중')
    && value.events.some(event => event.type === outcome && event.sourceIsNull
      && event.origin === 'chrome://userchrome' && event.keyMatches));
  // Failed/disconnected can already match before the native click's queued
  // messages run. Wait for this retry's authenticated outcome as well.
  const observed = await waitUntil(read, value => matches(value) && retryObserved(value),
    { timeoutMs: 15000, intervalMs: 100 });
  assert.ok(observed.randomUuidAvailable && observed.documentKeyVisible,
    'the real privileged document must publish its readable per-document key');
  if (args.has('--retry')) {
    assert.ok(observed.transitions.includes('연결 중'), 'native retry reaches the window header');
    assert.ok(observed.events.some(event => event.type === outcome
      && event.sourceIsNull && event.origin === 'chrome://userchrome' && event.keyMatches),
    'observe a real null-source outcome from this terminal document');
  }
  await harness.snapshot('.egd-terminal-card');
  const screenshot = await captureHeadlessScreenshot(harness, `terminal-status-${expected}`, Date.now() + 30000);
  const result = { kind: 'egdesk-terminal-status-live-verification', expected,
    retried: args.has('--retry'), observed, screenshot, checkedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(harness.evidenceDir, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ ...result, evidenceDir: harness.evidenceDir }, null, 2));
} finally {
  if (installed) await harness.evaluateChrome(`() => {
    const qa = window.__egdeskTerminalStatusQa;
    if (qa) { window.removeEventListener('message', qa.onMessage); qa.observer.disconnect(); delete window.__egdeskTerminalStatusQa; }
    return { removed: true };
  }`).catch(() => {});
  await harness.close();
}
