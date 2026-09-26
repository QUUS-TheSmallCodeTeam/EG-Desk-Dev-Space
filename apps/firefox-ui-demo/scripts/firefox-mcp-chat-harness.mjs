import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertQaProfile, canonicalTempRoot } from './egdesk-chat-qa-profile.mjs';

// Fixed, already-cached executable: no npx, install, or package resolution.
// Main starts and stops Firefox and the bridge separately.
export const CACHED_MCP_ENTRY = '/Users/minsoocha/.npm/_npx/96bbc051a9e217ad/node_modules/@mozilla/firefox-devtools-mcp-moz/dist.moz/index.js';
export const CACHED_GECKODRIVER = '/Users/minsoocha/.cache/selenium/geckodriver/mac-arm64/0.37.0/geckodriver';
export const QA_MARIONETTE_PORT = 2829;

export function mcpResultText(result) {
  return (result?.content || []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
}

export function parseMcpJson(result) {
  if (result?.structuredContent != null) return result.structuredContent;
  const text = mcpResultText(result).trim();
  const fenced = text.match(/```json\s*\n([\s\S]*?)\n```/);
  return JSON.parse(fenced ? fenced[1] : text.replace(/^Result:\s*/, ''));
}

export function decodeQaEvaluationResult(wire) {
  if (typeof wire !== 'string') throw new Error('QA Chrome result must cross BiDi as a JSON string');
  const result = JSON.parse(wire);
  if (result?.qaEvaluation !== 1) throw new Error('Unexpected profile-bound evaluation result');
  if (!result.ok) throw new Error(`Chrome evaluation failed: ${result.error.message}\n${result.error.stack}`);
  return result.value;
}

export function contextIdFromList(text) {
  const match = text.match(/([0-9a-f-]{36})\s*:\s*chrome:\/\/browser\/content\/browser\.xhtml/i);
  if (!match) throw new Error('Firefox browser-chrome privileged context not found');
  return match[1];
}

export function firstSnapshotUid(text) {
  const match = text.match(/\buid\s*[=:]\s*["']?([^\s"'<>\[\],}]+)/i);
  if (!match) throw new Error('MCP snapshot has no native-action UID; no synthetic DOM fallback');
  return match[1];
}

export function chooseNativeScrollKey({ scrollTop, scrollHeight, clientHeight }) {
  const max = scrollHeight - clientHeight;
  if (!(max > 1)) throw new Error('Native scroll target has no overflow');
  return scrollTop < max - 1 ? 'PageDown' : 'PageUp';
}

export function createQaEvidenceDirectory() {
  const created = fs.mkdtempSync(path.join(canonicalTempRoot(), 'egdesk-chat-evidence-'));
  const canonical = fs.realpathSync.native(created);
  if (canonical !== created || path.dirname(canonical) !== canonicalTempRoot()) {
    throw new Error('QA evidence directory is not a canonical temp child');
  }
  fs.chmodSync(canonical, 0o700);
  return assertQaEvidenceDirectory(canonical);
}

export function assertQaEvidenceDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new Error('QA evidence directory must be absolute');
  }
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() ||
      (info.mode & 0o022) !== 0 || fs.realpathSync.native(directory) !== directory ||
      path.dirname(directory) !== canonicalTempRoot() ||
      !path.basename(directory).startsWith('egdesk-chat-evidence-')) {
    throw new Error('QA evidence directory must be a safe canonical temp directory');
  }
  return directory;
}

export async function waitUntil(read, accept, { timeoutMs = 15000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for observed state: ${JSON.stringify(last)?.slice(0, 500)}`);
}

export class FirefoxMcpChatHarness {
  #profile;
  #port;
  #proc = null;
  #buffer = '';
  #stderr = '';
  #pending = new Map();
  #nextId = 1;
  #context = null;
  #tools = new Set();
  #evidenceDir;

  constructor({ profile, marionettePort = Number(process.env.EGDESK_MARIONETTE_PORT || QA_MARIONETTE_PORT) }) {
    this.#profile = assertQaProfile(profile);
    if (marionettePort !== QA_MARIONETTE_PORT) {
      throw new Error(`QA harness refuses Marionette port ${marionettePort}; expected ${QA_MARIONETTE_PORT}`);
    }
    this.#port = marionettePort;
    const info = fs.statSync(CACHED_MCP_ENTRY);
    if (!info.isFile()) throw new Error('Cached Firefox MCP entry is not a file');
    if (!fs.statSync(CACHED_GECKODRIVER).isFile()) throw new Error('Cached geckodriver is missing; downloads are disabled');
    fs.accessSync(CACHED_GECKODRIVER, fs.constants.X_OK);
    this.#evidenceDir = createQaEvidenceDirectory();
  }

  get profile() { return this.#profile; }
  get evidenceDir() { return this.#evidenceDir; }
  get stderrTail() { return this.#stderr; }

  async connect() {
    if (this.#proc) throw new Error('MCP transport already connected');
    assertQaProfile(this.#profile);
    assertQaEvidenceDirectory(this.#evidenceDir);
    this.#proc = spawn(process.execPath, [
      CACHED_MCP_ENTRY, '--connectExisting', '--marionettePort', String(this.#port),
      '--enablePrivilegedContext', '--enableScript',
    ], { cwd: this.#evidenceDir, stdio: ['pipe', 'pipe', 'pipe'],
      // The cached MCP otherwise downloads geckodriver when discovery fails.
      env: { ...process.env, PATH: `${path.dirname(CACHED_GECKODRIVER)}${path.delimiter}${process.env.PATH || ''}` },
    });
    this.#proc.stdout.on('data', (chunk) => this.#handleOutput(chunk));
    this.#proc.stderr.on('data', (chunk) => { this.#stderr = (this.#stderr + chunk).slice(-8000); });
    this.#proc.on('error', (error) => this.#rejectPending(error));
    this.#proc.stdin.on('error', (error) => this.#rejectPending(error));
    this.#proc.on('exit', (code, signal) => this.#rejectPending(new Error(`MCP exited ${code ?? signal}`)));
    await this.#request('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'egdesk-isolated-chat-qa', version: '1.0.0' } });
    this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const tools = await this.#request('tools/list');
    this.#tools = new Set((tools.tools || []).map((tool) => tool.name));
    for (const name of ['list_privileged_contexts', 'select_privileged_context', 'evaluate_privileged_script',
      'take_snapshot', 'clear_snapshot', 'click_by_uid', 'fill_by_uid', 'press_key', 'type_text', 'screenshot_page']) {
      if (!this.#tools.has(name)) throw new Error(`Cached MCP lacks required tool: ${name}`);
    }
    const contexts = mcpResultText(await this.#call('list_privileged_contexts'));
    this.#context = contextIdFromList(contexts);
    await this.#call('select_privileged_context', { contextId: this.#context });
    await this.assertRemoteProfile();
    // MCP 0.10.4 restarts its UID counter for each transport while its page-side
    // registry survives. Clear only that tool-owned cache to prevent collisions
    // between old element IDs and this connection's newly assigned IDs.
    await this.#call('clear_snapshot');
    return this;
  }

  #rejectPending(error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

  #handleOutput(chunk) {
    this.#buffer += String(chunk);
    let end;
    while ((end = this.#buffer.indexOf('\n')) >= 0) {
      const line = this.#buffer.slice(0, end).trim();
      this.#buffer = this.#buffer.slice(end + 1);
      if (!line.startsWith('{')) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    }
  }

  #request(method, params = {}, timeoutMs = 30000) {
    if (!this.#proc || !this.#proc.stdin.writable) throw new Error('MCP transport is not writable');
    return new Promise((resolve, reject) => {
      const id = this.#nextId++;
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP ${method} timed out; UI actions are never retried automatically`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve(value) { clearTimeout(timer); resolve(value); },
        reject(error) { clearTimeout(timer); reject(error); },
      });
      this.#proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async #call(name, args = {}, timeoutMs = 30000) {
    const result = await this.#request('tools/call', { name, arguments: args }, timeoutMs);
    const output = mcpResultText(result);
    if (result?.isError || /^Error:/m.test(output.trim())) throw new Error(`${name}: ${output}`);
    return result;
  }

  async #readChromeRaw(functionSource) {
    if (!this.#context) throw new Error('No selected privileged context');
    return parseMcpJson(await this.#call('evaluate_privileged_script', {
      context: this.#context, function: functionSource,
    }));
  }

  async assertRemoteProfile() {
    assertQaProfile(this.#profile);
    const actual = await this.#readChromeRaw(`() => {
      const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
      return services.dirsvc.get('ProfD', Ci.nsIFile).path;
    }`);
    if (actual !== this.#profile) throw new Error(`Refusing different Firefox profile: ${actual}`);
    return actual;
  }

  async evaluateChrome(functionSource) {
    if (typeof functionSource !== 'string' || !/^\s*(?:async\s*)?\(.*?\)\s*=>/s.test(functionSource)) {
      throw new Error('Chrome evaluation needs a callable function string');
    }
    await this.assertRemoteProfile();
    const boundSource = `async () => {
      const services = globalThis.Services || ChromeUtils.importESModule('resource://gre/modules/Services.sys.mjs').Services;
      if (services.dirsvc.get('ProfD', Ci.nsIFile).path !== ${JSON.stringify(this.#profile)}) {
        throw new Error('QA evaluation refused a different live Firefox profile');
      }
      try {
        return JSON.stringify({ qaEvaluation: 1, ok: true, value: await (${functionSource})() });
      } catch (error) {
        return JSON.stringify({ qaEvaluation: 1, ok: false, error: { message: error.message || String(error), stack: error.stack || '' } });
      }
    }`;
    if (Buffer.byteLength(boundSource, 'utf8') >= 16 * 1024) {
      throw new Error('Profile-bound Chrome evaluation exceeds the MCP size limit');
    }
    // Cached MCP 0.10.4 assumes every BiDi object has a value array. Repeated
    // object references omit that array, so send one JSON string across BiDi.
    return decodeQaEvaluationResult(await this.#readChromeRaw(boundSource));
  }

  // Read-only DOM observation; all input below goes through MCP native tools.
  async inspect(selector) {
    return this.evaluateChrome(`() => {
      const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
      return nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return { tag: node.localName, text: (node.textContent || '').trim().slice(0, 3000),
          value: 'value' in node ? node.value : null, id: node.id || null,
          testId: node.getAttribute('data-testid'), role: node.getAttribute('role'),
          ariaLabel: node.getAttribute('aria-label'), disabled: !!node.disabled,
          focused: document.activeElement === node,
          className: typeof node.className === 'string' ? node.className : '',
          dataset: { ...node.dataset },
          visible: rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden',
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          scrollTop: node.scrollTop, scrollHeight: node.scrollHeight, clientHeight: node.clientHeight };
      });
    }`);
  }

  async uidFor(selector) {
    const nodes = await this.inspect(selector);
    if (nodes.length !== 1 || !nodes[0].visible) {
      throw new Error(`Expected exactly one visible UI element for ${selector}; found ${nodes.length}`);
    }
    return firstSnapshotUid(await this.snapshot(selector));
  }

  async snapshot(selector) {
    await this.assertRemoteProfile();
    return mcpResultText(await this.#call('take_snapshot', {
      selector, includeAll: true, includeAttributes: true, maxLines: 50,
    }));
  }

  async click(selector) {
    const uid = await this.uidFor(selector);
    await this.assertRemoteProfile();
    return this.#call('click_by_uid', { uid });
  }

  async fill(selector, value) {
    const uid = await this.uidFor(selector);
    await this.assertRemoteProfile();
    return this.#call('fill_by_uid', { uid, value });
  }

  async press(key, selector) {
    const uid = selector ? await this.uidFor(selector) : undefined;
    await this.assertRemoteProfile();
    return this.#call('press_key', { key, ...(uid ? { uid } : {}) });
  }

  async typeText(text, { selector, submitKey } = {}) {
    if (typeof text !== 'string') throw new Error('Native typing requires text');
    const uid = selector ? await this.uidFor(selector) : undefined;
    await this.assertRemoteProfile();
    return this.#call('type_text', { text, ...(uid ? { uid } : {}), ...(submitKey ? { submitKey } : {}) });
  }

  async scrollWithKey(selector, key = 'auto') {
    if (!['auto', 'PageDown', 'PageUp', 'End', 'Home'].includes(key)) throw new Error('Unsupported native scroll key');
    const before = (await this.inspect(selector))[0];
    if (!before) throw new Error(`Missing scroll target: ${selector}`);
    if (key === 'auto') key = chooseNativeScrollKey(before);
    const max = before.scrollHeight - before.clientHeight;
    const direction = ['PageDown', 'End'].includes(key) ? 1 : -1;
    const hasRoom = direction > 0 ? before.scrollTop < max - 0.5 : before.scrollTop > 0.5;
    await this.press(key, selector);
    const read = async () => (await this.inspect(selector))[0];
    const after = hasRoom
      ? await waitUntil(read, value => value && direction * (value.scrollTop - before.scrollTop) > 0.5,
        { timeoutMs: 2000, intervalMs: 50 })
      : await read();
    if (!after) throw new Error(`Scroll target disappeared: ${selector}`);
    return { key, before: before.scrollTop, after: after.scrollTop, max,
      focused: after.focused, moved: direction * (after.scrollTop - before.scrollTop) > 0.5,
      overflow: max > 0 };
  }

  async screenshot(name) {
    await this.assertRemoteProfile();
    const canonicalDir = assertQaEvidenceDirectory(this.#evidenceDir);
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
      throw new Error('Screenshot target must be a named file in a dedicated canonical temp evidence directory');
    }
    const target = path.join(canonicalDir, `${name}.png`);
    if (fs.existsSync(target)) throw new Error(`Refusing to overwrite screenshot: ${target}`);
    // A relative saveTo stays inside this MCP child's dedicated temp cwd.
    // The cached MCP permits that without --unrestricted-save-paths.
    await this.#call('screenshot_page', { saveTo: `${name}.png` }, 45000);
    const info = fs.lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() ||
        fs.realpathSync.native(target) !== target) throw new Error('Screenshot is not a canonical owned file');
    const header = Buffer.alloc(8);
    const descriptor = fs.openSync(target, 'r');
    try { fs.readSync(descriptor, header, 0, 8, 0); } finally { fs.closeSync(descriptor); }
    if (!header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error(`Screenshot is not a PNG: ${target}`);
    }
    return target;
  }

  async close() {
    if (!this.#proc) return;
    const child = this.#proc;
    this.#rejectPending(new Error('MCP transport closed by the QA caller'));
    child.stdin.end();
    // Never signal Firefox, the bridge, or even this MCP child. Main owns
    // runtime lifecycle; wait for EOF cleanup before a subsequent test attaches.
    try {
      if (child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('MCP transport did not exit after EOF; no process signal was sent')), 10000);
          child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
      }
    } finally {
      child.unref();
      child.stdout.destroy();
      child.stderr.destroy();
      this.#proc = null;
      this.#context = null;
    }
  }
}
