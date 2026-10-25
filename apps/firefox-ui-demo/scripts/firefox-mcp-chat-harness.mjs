import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertQaProfile, canonicalTempRoot } from './egdesk-chat-qa-profile.mjs';
import { createPrivateQaTempDirectory, isOwnedAndPrivate } from './egdesk-qa-platform.mjs';

// Fixed, already-cached executable: no npx, install, or package resolution.
// Main starts and stops Firefox and the bridge separately.
export const CACHED_MCP_ENTRY = process.env.EGDESK_QA_MCP_ENTRY || (process.platform === 'darwin'
  ? '/Users/minsoocha/.npm/_npx/96bbc051a9e217ad/node_modules/@mozilla/firefox-devtools-mcp-moz/dist.moz/index.js' : null);
export const CACHED_GECKODRIVER = process.env.EGDESK_QA_GECKODRIVER || (process.platform === 'darwin'
  ? '/Users/minsoocha/.cache/selenium/geckodriver/mac-arm64/0.37.0/geckodriver' : null);
export const QA_MARIONETTE_PORT = 2829;
export const QA_NATIVE_INPUT_MAX_DELTA = 8192;

function cloneQaNativePointInput(kind, input) {
  const keys = kind === 'click' ? ['x', 'y'] : kind === 'wheel' ? ['x', 'y', 'deltaX', 'deltaY'] : null;
  if (!keys || !input || typeof input !== 'object' || Array.isArray(input) ||
      Reflect.ownKeys(input).length !== keys.length) throw new Error('Invalid native point input');
  const copy = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !('value' in descriptor) || !Number.isFinite(descriptor.value)) {
      throw new Error(`Native input ${key} must be a finite number data property`);
    }
    copy[key] = descriptor.value;
  }
  if (copy.x < 0 || copy.y < 0) throw new Error('Native input coordinates must be nonnegative');
  if (kind === 'wheel' && (!keys.every(key => Number.isSafeInteger(copy[key])) ||
      Math.abs(copy.deltaX) > QA_NATIVE_INPUT_MAX_DELTA || Math.abs(copy.deltaY) > QA_NATIVE_INPUT_MAX_DELTA ||
      (copy.deltaX === 0 && copy.deltaY === 0))) {
    throw new Error(`Wheel input requires integer coordinates and a nonzero delta bounded by ${QA_NATIVE_INPUT_MAX_DELTA}`);
  }
  return copy;
}

// Pure wire serialization; CSS viewport coordinates, never DOM scrolling/focus.
// https://developer.mozilla.org/en-US/docs/Web/WebDriver/Reference/BiDi/Modules/input/performActions
export function serializeQaNativeInput(kind, input, { context, width, height } = {}) {
  const point = cloneQaNativePointInput(kind, input);
  if (typeof context !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(context)) {
    throw new Error('Native input requires the selected browser-chrome context');
  }
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 ||
      point.x >= width || point.y >= height) throw new Error('Native input point is outside the observed viewport');
  const source = kind === 'click'
    ? { type: 'pointer', id: 'egdesk_qa_point_mouse', parameters: { pointerType: 'mouse' }, actions: [
      { type: 'pointerMove', origin: 'viewport', x: point.x, y: point.y, duration: 0 },
      { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
    ] }
    : { type: 'wheel', id: 'egdesk_qa_point_wheel', actions: [
      { type: 'scroll', origin: 'viewport', ...point, duration: 0 },
    ] };
  return { method: 'input.performActions', params: { context, actions: [source] } };
}

// 2829 remains the chat QA default. Main may explicitly select the separately
// launched 2828 target, but arbitrary ports are never accepted by this harness.
export function resolveQaMarionettePort(value = process.env.EGDESK_MARIONETTE_PORT || QA_MARIONETTE_PORT) {
  if (value !== 2828 && value !== 2829 && value !== '2828' && value !== '2829') {
    throw new Error(`QA harness refuses Marionette port ${value}; expected 2828 or 2829`);
  }
  return Number(value);
}

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
  const canonical = createPrivateQaTempDirectory('egdesk-chat-evidence-');
  return assertQaEvidenceDirectory(canonical);
}

export function assertQaEvidenceDirectory(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new Error('QA evidence directory must be absolute');
  }
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || !isOwnedAndPrivate(directory, info) ||
      fs.realpathSync.native(directory) !== directory ||
      path.dirname(directory) !== canonicalTempRoot() ||
      !path.basename(directory).startsWith('egdesk-chat-evidence-')) {
    throw new Error('QA evidence directory must be a safe canonical temp directory');
  }
  return directory;
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_CHROME_SNAPSHOT_DIMENSION = 8192;
const MAX_CHROME_SNAPSHOT_PIXELS = 16_777_216;
const MAX_CHROME_SNAPSHOT_BYTES = 16 * 1024 * 1024;

function pngDimensions(bytes) {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Screenshot is not a PNG with an IHDR');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) throw new Error('Screenshot PNG has invalid IHDR dimensions');
  return { width, height };
}

function boundedChromeSnapshotDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > MAX_CHROME_SNAPSHOT_DIMENSION || height > MAX_CHROME_SNAPSHOT_DIMENSION ||
      width * height > MAX_CHROME_SNAPSHOT_PIXELS) {
    throw new Error('Headless Chrome screenshot dimensions exceed the QA bound');
  }
}

function decodeChromeSnapshotPng(value) {
  const encoded = value?.pngBase64;
  if (typeof encoded !== 'string' || encoded.length < 4 ||
      encoded.length > 4 * Math.ceil(MAX_CHROME_SNAPSHOT_BYTES / 3) ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('Headless Chrome screenshot has invalid bounded base64');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length > MAX_CHROME_SNAPSHOT_BYTES || bytes.toString('base64') !== encoded) {
    throw new Error('Headless Chrome screenshot exceeds the QA byte bound');
  }
  const dimensions = pngDimensions(bytes);
  boundedChromeSnapshotDimensions(dimensions.width, dimensions.height);
  if (dimensions.width !== value.width || dimensions.height !== value.height) {
    throw new Error('Headless Chrome screenshot IHDR differs from the captured bitmap');
  }
  return bytes;
}

function inspectQaScreenshotFile(target) {
  const info = fs.lstatSync(target);
  if (!info.isFile() || info.isSymbolicLink() || !isOwnedAndPrivate(target, info) ||
      fs.realpathSync.native(target) !== target) throw new Error('Screenshot is not a canonical owned file');
  const header = Buffer.alloc(33);
  const descriptor = fs.openSync(target, 'r');
  try {
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) {
      throw new Error(`Screenshot is not a PNG with an IHDR: ${target}`);
    }
  } finally { fs.closeSync(descriptor); }
  return pngDimensions(header);
}

export function isUnsupportedBidiScreenshotError(error) {
  return error instanceof Error &&
    error.message === 'screenshot_page: Error: BiDi error: "unsupported operation"';
}

function remainingScreenshotMs(deadlineMs, capMs) {
  const remaining = deadlineMs - Date.now();
  if (!Number.isSafeInteger(deadlineMs) || remaining <= 0) throw new Error('Screenshot deadline exceeded');
  return Math.max(1, Math.min(remaining, capMs));
}

async function beforeScreenshotDeadline(run, deadlineMs, capMs) {
  const waitMs = remainingScreenshotMs(deadlineMs, capMs);
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(waitMs === capMs
          ? 'Screenshot operation timed out' : 'Screenshot deadline exceeded')), waitMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

function headlessChromeSnapshotSource(deadlineMs) {
  return `async () => {
    const uri = 'chrome://browser/content/browser.xhtml';
    const gfx = Cc['@mozilla.org/gfx/info;1'].getService(Ci.nsIGfxInfo);
    const bc = window.docShell?.browsingContext;
    const wg = bc?.currentWindowGlobal;
    const assertLiveRoot = () => {
      if (Date.now() >= ${deadlineMs}) throw new Error('Screenshot deadline exceeded');
      if (gfx.isHeadless !== true) throw new Error('Headless Chrome screenshot refused a non-headless Firefox');
      if (window.document.documentURI !== uri || window.docShell?.browsingContext !== bc ||
          bc?.isContent !== false || bc?.parent !== null || !wg ||
          bc.currentWindowGlobal !== wg || wg.isCurrentGlobal !== true) {
        throw new Error('Stale or non-root browser-chrome screenshot context');
      }
    };
    assertLiveRoot();
    const width = window.innerWidth;
    const height = window.innerHeight;
    const dpr = window.devicePixelRatio;
    if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(dpr) ||
        width < 1 || height < 1 || dpr <= 0 || dpr > 4 ||
        width > ${MAX_CHROME_SNAPSHOT_DIMENSION} || height > ${MAX_CHROME_SNAPSHOT_DIMENSION} ||
        Math.ceil(width * dpr) > ${MAX_CHROME_SNAPSHOT_DIMENSION} ||
        Math.ceil(height * dpr) > ${MAX_CHROME_SNAPSHOT_DIMENSION} ||
        Math.ceil(width * dpr) * Math.ceil(height * dpr) > ${MAX_CHROME_SNAPSHOT_PIXELS}) {
      throw new Error('Headless Chrome viewport exceeds the QA pixel bound');
    }
    let bitmap;
    try {
      bitmap = await wg.drawSnapshot(new DOMRect(0, 0, width, height), dpr,
        'rgb(255,255,255)', { drawView: true });
      assertLiveRoot();
      const capturedWidth = bitmap?.width;
      const capturedHeight = bitmap?.height;
      if (!Number.isSafeInteger(capturedWidth) || !Number.isSafeInteger(capturedHeight) ||
          capturedWidth < 1 || capturedHeight < 1 ||
          capturedWidth > ${MAX_CHROME_SNAPSHOT_DIMENSION} ||
          capturedHeight > ${MAX_CHROME_SNAPSHOT_DIMENSION} ||
          capturedWidth * capturedHeight > ${MAX_CHROME_SNAPSHOT_PIXELS}) {
        throw new Error('Headless Chrome bitmap exceeds the QA pixel bound');
      }
      const canvas = window.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
      canvas.width = capturedWidth;
      canvas.height = capturedHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Headless Chrome screenshot canvas unavailable');
      context.drawImage(bitmap, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');
      assertLiveRoot();
      const prefix = 'data:image/png;base64,';
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith(prefix) ||
          dataUrl.length - prefix.length > ${4 * Math.ceil(MAX_CHROME_SNAPSHOT_BYTES / 3)}) {
        throw new Error('Headless Chrome screenshot exceeds the QA encoded byte bound');
      }
      return { pngBase64: dataUrl.slice(prefix.length), width: capturedWidth, height: capturedHeight };
    } finally { bitmap?.close(); }
  }`;
}

// The class keeps returning a path; this small seam permits offline tests of
// the exact fallback gate without connecting to Firefox or starting MCP.
export async function captureQaScreenshot({ name, evidenceDir, assertRemoteProfile, screenshotPage,
  evaluateChrome, allowHeadlessChromeFallback = false, deadlineMs } = {}) {
  if (allowHeadlessChromeFallback && (!Number.isSafeInteger(deadlineMs) || deadlineMs <= Date.now())) {
    throw new Error('Headless Chrome screenshot fallback requires an explicit future deadlineMs');
  }
  if (allowHeadlessChromeFallback) {
    await beforeScreenshotDeadline(assertRemoteProfile, deadlineMs, 30000);
  } else await assertRemoteProfile();
  const canonicalDir = assertQaEvidenceDirectory(evidenceDir);
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    throw new Error('Screenshot target must be a named file in a dedicated canonical temp evidence directory');
  }
  const target = path.join(canonicalDir, `${name}.png`);
  if (fs.existsSync(target)) throw new Error(`Refusing to overwrite screenshot: ${target}`);
  let route = 'mcp-screenshot-page';
  try {
    await screenshotPage(`${name}.png`, allowHeadlessChromeFallback
      ? remainingScreenshotMs(deadlineMs, 45000) : 45000);
    if (allowHeadlessChromeFallback) remainingScreenshotMs(deadlineMs, 1);
  } catch (error) {
    if (!allowHeadlessChromeFallback || !isUnsupportedBidiScreenshotError(error)) throw error;
    if (fs.existsSync(target)) throw new Error(`Refusing to overwrite screenshot: ${target}`);
    const value = await beforeScreenshotDeadline(
      () => evaluateChrome(headlessChromeSnapshotSource(deadlineMs)), deadlineMs, 30000);
    const bytes = decodeChromeSnapshotPng(value);
    remainingScreenshotMs(deadlineMs, 1);
    fs.writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 });
    route = 'headless-chrome-drawSnapshot';
  }
  const { width, height } = inspectQaScreenshotFile(target);
  if (allowHeadlessChromeFallback) remainingScreenshotMs(deadlineMs, 1);
  return { path: target, route, width, height, visualPass: null };
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
  #lastScreenshotMetadata = null;

  constructor({ profile, marionettePort = resolveQaMarionettePort() }) {
    this.#profile = assertQaProfile(profile);
    this.#port = resolveQaMarionettePort(marionettePort);
    for (const [file, label] of [[CACHED_MCP_ENTRY, 'EGDESK_QA_MCP_ENTRY'],
      [CACHED_GECKODRIVER, 'EGDESK_QA_GECKODRIVER']]) {
      if (typeof file !== 'string' || !path.isAbsolute(file) || /[\r\n]/.test(file)
          || !fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()
          || fs.realpathSync.native(file) !== file) {
        throw new Error(`${label} must name an explicit canonical installed file; automatic downloads are disabled`);
      }
    }
    if (path.basename(CACHED_GECKODRIVER) !== (process.platform === 'win32' ? 'geckodriver.exe' : 'geckodriver')) {
      throw new Error('Installed geckodriver has an unexpected executable name');
    }
    fs.accessSync(CACHED_GECKODRIVER, fs.constants.X_OK);
    this.#evidenceDir = createQaEvidenceDirectory();
  }

  get profile() { return this.#profile; }
  get marionettePort() { return this.#port; }
  get evidenceDir() { return this.#evidenceDir; }
  get stderrTail() { return this.#stderr; }
  get lastScreenshotMetadata() { return this.#lastScreenshotMetadata && { ...this.#lastScreenshotMetadata }; }

  async connect() {
    if (this.#proc) throw new Error('MCP transport already connected');
    assertQaProfile(this.#profile);
    assertQaEvidenceDirectory(this.#evidenceDir);
    const childEnv = { ...process.env };
    const pathKeys = Object.keys(childEnv).filter(key => key.toUpperCase() === 'PATH');
    const inheritedPath = childEnv[pathKeys[0]] || '';
    for (const key of pathKeys) delete childEnv[key];
    childEnv.PATH = `${path.dirname(CACHED_GECKODRIVER)}${path.delimiter}${inheritedPath}`;
    this.#proc = spawn(process.execPath, [
      CACHED_MCP_ENTRY, '--connectExisting', '--marionettePort', String(this.#port),
      '--enablePrivilegedContext', '--enableScript',
    ], { cwd: this.#evidenceDir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      // The cached MCP otherwise downloads geckodriver when discovery fails.
      env: childEnv,
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

  // The app redraws its panels on every state event. When that lands between the
  // snapshot and the native input, the MCP rejects the UID before dispatching
  // anything, so taking a fresh snapshot and trying again cannot double-send.
  async #withFreshUid(action) {
    for (let attempt = 1; ; attempt++) {
      try { return await action(); }
      catch (error) {
        if (attempt >= 3 || !/stale\/invalid/.test(String(error?.message))) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
  }

  async click(selector) {
    return this.#withFreshUid(async () => {
      const uid = await this.uidFor(selector);
      await this.assertRemoteProfile();
      return this.#call('click_by_uid', { uid });
    });
  }

  async #pointInput(kind, input) {
    // Own caller data before the first await; never accept context/tool overrides.
    const point = cloneQaNativePointInput(kind, input);
    const connection = this.#proc;
    const context = this.#context;
    const assertCurrent = () => {
      if (!connection || !connection.stdin.writable || this.#proc !== connection ||
          !context || this.#context !== context) throw new Error('Native input connection/context changed or unavailable');
      if (!this.#tools.has('send_bidi_command')) throw new Error('Cached MCP lacks native input tool: send_bidi_command');
    };
    assertCurrent();
    const viewport = await this.evaluateChrome(`() => {
      const bc = window.docShell?.browsingContext;
      if (window.document.documentURI !== 'chrome://browser/content/browser.xhtml' ||
          bc?.isContent !== false || bc?.parent !== null || bc?.currentWindowGlobal?.isCurrentGlobal !== true) {
        throw new Error('Native input refused a stale or non-root browser-chrome context');
      }
      return { width: window.innerWidth, height: window.innerHeight };
    }`);
    assertCurrent();
    const payload = serializeQaNativeInput(kind, point, { context, width: viewport?.width, height: viewport?.height });
    await this.assertRemoteProfile();
    assertCurrent();
    // One request on this MCP transport, always with the original context ID.
    // Inside the owned isolated QA runner, MCP may recover its protocol session
    // (and tabs) before dispatch. Session/context survival is not guaranteed;
    // a missing original context must fail, never be replaced by a fresh one.
    // No harness retry, ambiguous input replay, selector fallback or releaseActions.
    return this.#call('send_bidi_command', payload);
  }

  async clickPoint(input) { return this.#pointInput('click', input); }

  async wheelAt(input) { return this.#pointInput('wheel', input); }

  async fill(selector, value) {
    return this.#withFreshUid(async () => {
      const uid = await this.uidFor(selector);
      await this.assertRemoteProfile();
      return this.#call('fill_by_uid', { uid, value });
    });
  }

  async press(key, selector) {
    return this.#withFreshUid(async () => {
      const uid = selector ? await this.uidFor(selector) : undefined;
      await this.assertRemoteProfile();
      return this.#call('press_key', { key, ...(uid ? { uid } : {}) });
    });
  }

  async typeText(text, { selector, submitKey } = {}) {
    if (typeof text !== 'string') throw new Error('Native typing requires text');
    return this.#withFreshUid(async () => {
      const uid = selector ? await this.uidFor(selector) : undefined;
      await this.assertRemoteProfile();
      return this.#call('type_text', { text, ...(uid ? { uid } : {}), ...(submitKey ? { submitKey } : {}) });
    });
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

  async screenshot(name, { allowHeadlessChromeFallback = false, deadlineMs } = {}) {
    this.#lastScreenshotMetadata = null;
    const result = await captureQaScreenshot({ name, evidenceDir: this.#evidenceDir,
      assertRemoteProfile: () => this.assertRemoteProfile(),
      // A relative saveTo stays inside this MCP child's dedicated temp cwd.
      screenshotPage: (saveTo, timeoutMs) => this.#call('screenshot_page', { saveTo }, timeoutMs),
      evaluateChrome: (source) => this.evaluateChrome(source),
      allowHeadlessChromeFallback, deadlineMs });
    this.#lastScreenshotMetadata = result;
    return result.path;
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
