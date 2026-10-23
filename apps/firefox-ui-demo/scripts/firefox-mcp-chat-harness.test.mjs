import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createPrivateQaTempDirectory } from './egdesk-qa-platform.mjs';
import { assertQaProfile, bootstrapQaProfile, canonicalTempRoot,
  assertQaFixtureManifest, LOADER_FILES, QA_MARKER_BYTES, QA_MARKER_NAME,
  QA_FIXTURE_DIRECTORY, QA_FIXTURE_FILE, QA_FIXTURE_MANIFEST, QA_REAL_TURN_DIRECTORY, QA_BACKEND_DATA_DIRECTORY, deskRecoveryFixture } from './egdesk-chat-qa-profile.mjs';
import { assertQaEvidenceDirectory, chooseNativeScrollKey, contextIdFromList, createQaEvidenceDirectory, firstSnapshotUid,
  captureQaScreenshot, decodeQaEvaluationResult, FirefoxMcpChatHarness, isUnsupportedBidiScreenshotError,
  mcpResultText, parseMcpJson,
  resolveQaMarionettePort } from './firefox-mcp-chat-harness.mjs';
import { assertQaFixtureArtifact } from './egdesk-chat-qa-contract.sys.mjs';
import { chatShellUsable, chooseQaThreadRow, composerIsReady } from './egdesk-qa-ui-flow.mjs';

function removeCreatedTemp(directory, prefix) {
  if (path.dirname(directory) !== canonicalTempRoot() || !path.basename(directory).startsWith(prefix)) {
    throw new Error(`Refusing test cleanup outside owned temp prefix: ${directory}`);
  }
  fs.rmSync(directory, { recursive: true, force: false });
}

function otherWritable(target, writable, privateMode = 0o600) {
  if (process.platform === 'win32') {
    execFileSync('icacls.exe', [target, ...(writable ? ['/grant', '*S-1-5-32-545:(W)']
      : ['/remove:g', '*S-1-5-32-545'])], { windowsHide: true, stdio: 'pipe' });
  } else fs.chmodSync(target, writable ? privateMode | 0o022 : privateMode);
}

test('bootstrap copies only allowlisted loader utilities into a guarded mkdtemp profile', (t) => {
  const source = fs.mkdtempSync(path.join(canonicalTempRoot(), 'egdesk-loader-fixture-'));
  t.after(() => removeCreatedTemp(source, 'egdesk-loader-fixture-'));
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(source, name), `loader fixture: ${name}\n`);
  const result = bootstrapQaProfile({ loaderSource: source });
  t.after(() => removeCreatedTemp(result.profile, 'egdesk-chat-test-'));
  assert.equal(result.profile, fs.realpathSync.native(result.profile));
  assert.equal(assertQaProfile(result.profile), result.profile);
  assert.deepEqual(fs.readdirSync(result.profile).sort(), [QA_MARKER_NAME, 'chrome', QA_FIXTURE_DIRECTORY].sort());
  assert.deepEqual(fs.readdirSync(path.join(result.profile, 'chrome', 'utils')).sort(), [...LOADER_FILES].sort());
  assert.deepEqual(fs.readFileSync(path.join(result.profile, QA_MARKER_NAME)), QA_MARKER_BYTES);
  assert.deepEqual(fs.readdirSync(path.join(result.profile, QA_FIXTURE_DIRECTORY)).sort(),
    [QA_FIXTURE_FILE, QA_FIXTURE_MANIFEST, QA_REAL_TURN_DIRECTORY, QA_BACKEND_DATA_DIRECTORY].sort());
  assert.equal(assertQaFixtureManifest(result.profile).realTurnCwd, result.realTurnCwd);
  assert.deepEqual(fs.readdirSync(result.realTurnCwd), []);
  assert.equal(assertQaFixtureManifest(result.profile).backendDataDir, result.backendDataDir);
  assert.deepEqual(fs.readdirSync(result.backendDataDir), []);
  assert.equal(assertQaFixtureManifest(result.profile).artifactPath, result.fixtureArtifact);
  for (const name of LOADER_FILES) {
    assert.equal(fs.readFileSync(path.join(result.profile, 'chrome', 'utils', name), 'utf8'), `loader fixture: ${name}\n`);
  }
  const artifact = { id: 'fixture', type: 'file', target: { path: result.fixtureArtifact },
    status: 'available', relation: 'referenced', sourceItemId: 'message',
    conversationId: 'conversation', runId: 'run', answerId: 'conversation/run', verifiedAt: new Date().toISOString() };
  assert.equal(assertQaFixtureArtifact(result.profile, artifact), result.fixtureArtifact);
  assert.throws(() => assertQaFixtureArtifact(result.profile,
    { ...artifact, target: { path: path.join(source, LOADER_FILES[0]) } }), /manifest-bound/);
  const manifestPath = path.join(result.profile, QA_FIXTURE_DIRECTORY, QA_FIXTURE_MANIFEST);
  const originalManifest = fs.readFileSync(manifestPath, 'utf8');
  fs.writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(originalManifest), backendDataDir: '/tmp/not-the-bound-directory' }));
  assert.throws(() => assertQaFixtureManifest(result.profile), /backend data directory/);
  fs.writeFileSync(manifestPath, originalManifest);
  fs.writeFileSync(manifestPath, JSON.stringify({ ...JSON.parse(originalManifest), artifactPath: '/tmp/unbound.txt' }));
  assert.throws(() => assertQaFixtureManifest(result.profile), /not bound/);
  fs.writeFileSync(manifestPath, originalManifest);
  fs.unlinkSync(result.fixtureArtifact);
  try {
    fs.symlinkSync(path.join(source, LOADER_FILES[0]), result.fixtureArtifact);
    assert.throws(() => assertQaFixtureManifest(result.profile), /regular files/);
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.diagnostic('File symlink creation needs Windows Developer Mode; directory junction denial is tested separately');
  }
});

test('QA profile guard rejects bad marker bytes, writable marker, and symlink alias', (t) => {
  const profile = createPrivateQaTempDirectory('egdesk-chat-test-');
  const alias = path.join(canonicalTempRoot(), `egdesk-chat-test-link-${process.pid}-${Date.now()}`);
  t.after(() => {
    if (fs.existsSync(alias)) fs.unlinkSync(alias);
    removeCreatedTemp(profile, 'egdesk-chat-test-');
  });
  const marker = path.join(profile, QA_MARKER_NAME);
  fs.writeFileSync(marker, QA_MARKER_BYTES, { mode: 0o600 });
  assert.equal(assertQaProfile(profile), profile);
  fs.writeFileSync(marker, 'wrong\n');
  assert.throws(() => assertQaProfile(profile), /exact V1 bytes/);
  fs.writeFileSync(marker, QA_MARKER_BYTES);
  otherWritable(marker, true);
  assert.throws(() => assertQaProfile(profile), /user-owned regular file/);
  otherWritable(marker, false);
  fs.symlinkSync(profile, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => assertQaProfile(alias), /real directory/);
});

test('QA bootstrap seeds exact recovery bytes; this does not exercise UI restoration', (t) => {
  const source = fs.mkdtempSync(path.join(canonicalTempRoot(), 'egdesk-loader-fixture-'));
  t.after(() => removeCreatedTemp(source, 'egdesk-loader-fixture-'));
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(source, name), `loader fixture: ${name}\n`);
  for (const kind of ['corrupt', 'partial']) {
    const result = bootstrapQaProfile({ loaderSource: source, deskRecovery: kind });
    t.after(() => removeCreatedTemp(result.profile, 'egdesk-chat-test-'));
    const expected = deskRecoveryFixture(kind);
    assert.deepEqual(assertQaFixtureManifest(result.profile).deskRecovery, expected);
    assert.ok(fs.readFileSync(path.join(result.profile, 'prefs.js'), 'utf8')
      .includes(`user_pref(${JSON.stringify(expected.prefName)}, ${JSON.stringify(expected.raw)});`));
    assert.equal(fs.existsSync(path.join(result.profile, 'user.js')), false);
  }
});

test('MCP parsing and evidence setup are pure of Firefox and never need npx', (t) => {
  const id = '12345678-1234-1234-1234-123456789abc';
  assert.equal(contextIdFromList(`  ${id}: chrome://browser/content/browser.xhtml`), id);
  assert.equal(firstSnapshotUid('  - textbox uid=qa-42 aria-label="Chat"'), 'qa-42');
  assert.throws(() => firstSnapshotUid('textbox Chat'), /no native-action UID/);
  assert.equal(mcpResultText({ content: [{ type: 'text', text: 'ok' }] }), 'ok');
  assert.deepEqual(parseMcpJson({ content: [{ type: 'text', text: '```json\n{"ok":true}\n```' }] }), { ok: true });
  const evidence = createQaEvidenceDirectory();
  t.after(() => removeCreatedTemp(evidence, 'egdesk-chat-evidence-'));
  assert.equal(path.dirname(evidence), canonicalTempRoot());
  assert.equal(assertQaEvidenceDirectory(evidence), evidence);
  otherWritable(evidence, true, 0o700);
  assert.throws(() => assertQaEvidenceDirectory(evidence), /safe canonical/);
  otherWritable(evidence, false, 0o700);
  assert.equal(FirefoxMcpChatHarness.prototype.call, undefined);
  assert.equal(FirefoxMcpChatHarness.prototype.request, undefined);
  assert.equal(typeof FirefoxMcpChatHarness.prototype.evaluateChrome, 'function');
  assert.equal(typeof Object.getOwnPropertyDescriptor(FirefoxMcpChatHarness.prototype, 'lastScreenshotMetadata')?.get, 'function');
});

const ONE_PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN9kAAAAASUVORK5CYII=';
const UNSUPPORTED_BIDI_SCREENSHOT = new Error('screenshot_page: Error: BiDi error: "unsupported operation"');

test('screenshot fallback gate accepts only unsupported BiDi screenshot_page, never profile/timeout/cancel errors', () => {
  assert.equal(isUnsupportedBidiScreenshotError(UNSUPPORTED_BIDI_SCREENSHOT), true);
  for (const message of [
    'screenshot_page: Error: BiDi error: "unsupported operation" for a different request',
    'screenshot_page: Error: BiDi error: "not supported"',
    'screenshot_page: UnsupportedOperationError: WebDriver BiDi browsingContext.captureScreenshot is not supported',
    'screenshot_by_uid: UnsupportedOperationError: BiDi browsingContext.captureScreenshot is not supported',
    'screenshot_page: UnsupportedOperationError: local file save is not supported',
    'screenshot_page: BiDi browsingContext.captureScreenshot timed out',
    'screenshot_page: BiDi browsingContext.captureScreenshot was cancelled',
    'screenshot_page: different profile; BiDi browsingContext.captureScreenshot unsupported',
    'screenshot_page: Chrome evaluation stale',
  ]) assert.equal(isUnsupportedBidiScreenshotError(new Error(message)), false, message);
  assert.equal(isUnsupportedBidiScreenshotError(UNSUPPORTED_BIDI_SCREENSHOT.message), false);
});

test('normal screenshot remains MCP-owned, returns path metadata and never evaluates Chrome', async (t) => {
  const evidenceDir = createQaEvidenceDirectory();
  t.after(() => removeCreatedTemp(evidenceDir, 'egdesk-chat-evidence-'));
  let profileChecks = 0;
  const result = await captureQaScreenshot({ name: 'normal', evidenceDir,
    assertRemoteProfile: async () => { profileChecks++; },
    screenshotPage: async (saveTo, timeoutMs) => {
      assert.equal(saveTo, 'normal.png');
      assert.equal(timeoutMs, 45000);
      fs.writeFileSync(path.join(evidenceDir, saveTo), Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'),
        { flag: 'wx', mode: 0o600 });
    },
    evaluateChrome: () => assert.fail('normal screenshot must not run the fallback'),
  });
  assert.equal(profileChecks, 1);
  assert.deepEqual(result, { path: path.join(evidenceDir, 'normal.png'), route: 'mcp-screenshot-page',
    width: 1, height: 1, visualPass: null });
  assert.equal(fs.readFileSync(result.path).toString('base64'), ONE_PIXEL_PNG_BASE64);
  await assert.rejects(captureQaScreenshot({ name: 'normal', evidenceDir,
    assertRemoteProfile: async () => {}, screenshotPage: () => assert.fail('existing screenshot must not be overwritten'),
  }), /Refusing to overwrite screenshot/);
});

test('opt-in normal screenshot cannot report success after its explicit deadline', async (t) => {
  const evidenceDir = createQaEvidenceDirectory();
  t.after(() => removeCreatedTemp(evidenceDir, 'egdesk-chat-evidence-'));
  const realNow = Date.now;
  const deadlineMs = realNow() + 5000;
  let pageCalled = false;
  try {
    await assert.rejects(captureQaScreenshot({ name: 'late-normal', evidenceDir,
      allowHeadlessChromeFallback: true, deadlineMs,
      assertRemoteProfile: async () => {},
      screenshotPage: async (saveTo) => {
        pageCalled = true;
        fs.writeFileSync(path.join(evidenceDir, saveTo), Buffer.from(ONE_PIXEL_PNG_BASE64, 'base64'),
          { flag: 'wx', mode: 0o600 });
        Date.now = () => deadlineMs + 1;
      },
      evaluateChrome: () => assert.fail('a completed normal capture must never switch routes'),
    }), /Screenshot deadline exceeded/);
  } finally { Date.now = realNow; }
  assert.equal(pageCalled, true, 'the deadline expires only after the normal screenshot completes');
});

test('opt-in unsupported BiDi screenshot produces a validated private PNG and explicit source metadata', async (t) => {
  const evidenceDir = createQaEvidenceDirectory();
  t.after(() => removeCreatedTemp(evidenceDir, 'egdesk-chat-evidence-'));
  let source;
  const result = await captureQaScreenshot({ name: 'fallback', evidenceDir,
    allowHeadlessChromeFallback: true, deadlineMs: Date.now() + 5000,
    assertRemoteProfile: async () => {},
    screenshotPage: async (saveTo, timeoutMs) => {
      assert.equal(saveTo, 'fallback.png');
      assert.ok(timeoutMs > 0 && timeoutMs <= 5000);
      throw UNSUPPORTED_BIDI_SCREENSHOT;
    },
    evaluateChrome: async (functionSource) => {
      source = functionSource;
      return { pngBase64: ONE_PIXEL_PNG_BASE64, width: 1, height: 1 };
    },
  });
  assert.equal(result.path, path.join(evidenceDir, 'fallback.png'));
  assert.equal(result.route, 'headless-chrome-drawSnapshot');
  assert.equal(result.visualPass, null, 'capturing pixels does not award a visual pass');
  assert.deepEqual([result.width, result.height], [1, 1]);
  assert.equal(fs.readFileSync(result.path).toString('base64'), ONE_PIXEL_PNG_BASE64);
  if (process.platform !== 'win32') assert.equal(fs.statSync(result.path).mode & 0o777, 0o600);
  assert.match(source, /wg\.drawSnapshot\(new DOMRect\(0, 0, width, height\), dpr,/);
  assert.match(source, /'rgb\(255,255,255\)', \{ drawView: true \}/);
  assert.match(source, /window\.document\.createElementNS\('http:\/\/www\.w3\.org\/1999\/xhtml', 'canvas'\)/);
  assert.match(source, /finally \{ bitmap\?\.close\(\); \}/);
});

test('screenshot fallback refuses missing deadline, unrelated failures, stale evaluation and invalid PNG data', async (t) => {
  const evidenceDir = createQaEvidenceDirectory();
  t.after(() => removeCreatedTemp(evidenceDir, 'egdesk-chat-evidence-'));
  let evaluations = 0;
  const base = { evidenceDir, assertRemoteProfile: async () => {},
    screenshotPage: async () => { throw UNSUPPORTED_BIDI_SCREENSHOT; },
    evaluateChrome: async () => { evaluations++; return { pngBase64: ONE_PIXEL_PNG_BASE64, width: 1, height: 1 }; } };
  await assert.rejects(captureQaScreenshot({ ...base, name: 'no-opt-in' }), /unsupported operation/);
  assert.equal(evaluations, 0);
  await assert.rejects(captureQaScreenshot({ ...base, name: 'no-deadline', allowHeadlessChromeFallback: true }),
    /explicit future deadlineMs/);
  assert.equal(evaluations, 0);
  const deadlineMs = Date.now() + 5000;
  for (const [name, error] of [
    ['timeout', new Error('screenshot_page: BiDi browsingContext.captureScreenshot timed out')],
    ['cancel', new Error('screenshot_page: BiDi browsingContext.captureScreenshot cancelled')],
    ['unsupported-other', new Error('screenshot_page: UnsupportedOperationError: WebDriver BiDi browsingContext.captureScreenshot is not supported')],
    ['other', new Error('screenshot_page: file save refused')],
  ]) {
    await assert.rejects(captureQaScreenshot({ ...base, name, allowHeadlessChromeFallback: true,
      deadlineMs, screenshotPage: async () => { throw error; } }), (actual) => actual === error);
    assert.equal(fs.existsSync(path.join(evidenceDir, `${name}.png`)), false);
  }
  assert.equal(evaluations, 0);
  await assert.rejects(captureQaScreenshot({ ...base, name: 'profile', allowHeadlessChromeFallback: true,
    deadlineMs, assertRemoteProfile: async () => { throw new Error('different Firefox profile'); } }), /different Firefox profile/);
  assert.equal(evaluations, 0);
  for (const [name, value] of [
    ['bad-base64', { pngBase64: '!not-base64!', width: 1, height: 1 }],
    ['not-png', { pngBase64: Buffer.from('not a PNG').toString('base64'), width: 1, height: 1 }],
    ['bad-ihdr', { pngBase64: ONE_PIXEL_PNG_BASE64, width: 2, height: 1 }],
    ['huge-bitmap', { pngBase64: ONE_PIXEL_PNG_BASE64, width: 999999, height: 1 }],
  ]) {
    await assert.rejects(captureQaScreenshot({ ...base, name, allowHeadlessChromeFallback: true,
      deadlineMs, evaluateChrome: async () => value }), /base64|PNG|IHDR|dimensions/);
    assert.equal(fs.existsSync(path.join(evidenceDir, `${name}.png`)), false);
  }
  for (const [name, message] of [['stale', 'Stale browser chrome context'],
    ['eval-cancel', 'Screenshot capture cancelled'], ['eval-deadline', 'Screenshot deadline exceeded']]) {
    await assert.rejects(captureQaScreenshot({ ...base, name, allowHeadlessChromeFallback: true,
      deadlineMs, evaluateChrome: async () => { throw new Error(message); } }),
    (error) => error.message === message);
    assert.equal(fs.existsSync(path.join(evidenceDir, `${name}.png`)), false);
  }
});

test('headless Chrome snapshot callback guards real root context and closes bitmap on success or failure', async (t) => {
  const evidenceDir = createQaEvidenceDirectory();
  t.after(() => removeCreatedTemp(evidenceDir, 'egdesk-chat-evidence-'));
  let source;
  const result = await captureQaScreenshot({ name: 'source-check', evidenceDir,
    allowHeadlessChromeFallback: true, deadlineMs: Date.now() + 5000,
    assertRemoteProfile: async () => {}, screenshotPage: async () => { throw UNSUPPORTED_BIDI_SCREENSHOT; },
    evaluateChrome: async (functionSource) => {
      source = functionSource;
      return { pngBase64: ONE_PIXEL_PNG_BASE64, width: 1, height: 1 };
    } });
  assert.ok(fs.existsSync(result.path));
  const runSnapshot = async ({ headless = true, uri = 'chrome://browser/content/browser.xhtml',
    isContent = false, parent = null, isCurrentGlobal = true, staleAfterDraw = false,
    failCanvas = false } = {}) => {
    const observed = { calls: 0, closes: 0, drawArgs: null, canvasCreates: [] };
    const bitmap = { width: 1, height: 1, close() { observed.closes++; } };
    const bc = { isContent, parent, currentWindowGlobal: null };
    const wg = { isCurrentGlobal, async drawSnapshot(...args) {
      observed.calls++;
      observed.drawArgs = args;
      if (staleAfterDraw) bc.currentWindowGlobal = { isCurrentGlobal: true };
      return bitmap;
    } };
    bc.currentWindowGlobal = wg;
    const canvas = { getContext: () => ({ drawImage() {} }),
      toDataURL: () => { if (failCanvas) throw new Error('canvas failed');
        return `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`; } };
    const document = { documentURI: uri,
      createElement: () => { throw new Error('XUL canvas creation is not supported'); },
      createElementNS(namespace, localName) {
        observed.canvasCreates.push([namespace, localName]);
        return canvas;
      } };
    const window = { document, docShell: { browsingContext: bc }, innerWidth: 1, innerHeight: 1, devicePixelRatio: 1 };
    const context = { Cc: { '@mozilla.org/gfx/info;1': { getService: () => ({ isHeadless: headless }) } },
      Ci: { nsIGfxInfo: {} }, window, DOMRect: class DOMRect {
        constructor(x, y, width, height) { Object.assign(this, { x, y, width, height }); }
      } };
    try {
      const value = await runInNewContext(`(${source})()`, context);
      return { observed, value };
    } catch (error) { return { observed, error }; }
  };
  const ok = await runSnapshot();
  assert.equal(ok.error, undefined);
  assert.deepEqual([ok.value.width, ok.value.height, ok.value.pngBase64], [1, 1, ONE_PIXEL_PNG_BASE64]);
  assert.deepEqual([ok.observed.drawArgs[0].x, ok.observed.drawArgs[0].y,
    ok.observed.drawArgs[0].width, ok.observed.drawArgs[0].height], [0, 0, 1, 1]);
  assert.equal(ok.observed.drawArgs[1], 1);
  assert.equal(ok.observed.drawArgs[2], 'rgb(255,255,255)');
  assert.equal(ok.observed.drawArgs[3].drawView, true);
  assert.deepEqual(ok.observed.canvasCreates, [['http://www.w3.org/1999/xhtml', 'canvas']]);
  assert.equal(ok.observed.closes, 1);
  for (const [options, pattern, draws, closes] of [
    [{ headless: false }, /non-headless/, 0, 0],
    [{ uri: 'https://example.test/' }, /non-root/, 0, 0],
    [{ isContent: true }, /non-root/, 0, 0],
    [{ parent: {} }, /non-root/, 0, 0],
    [{ isCurrentGlobal: false }, /non-root/, 0, 0],
    [{ staleAfterDraw: true }, /Stale/, 1, 1],
    [{ failCanvas: true }, /canvas failed/, 1, 1],
  ]) {
    const outcome = await runSnapshot(options);
    assert.match(outcome.error?.message || '', pattern);
    assert.equal(outcome.observed.calls, draws);
    assert.equal(outcome.observed.closes, closes);
  }
});

test('QA port policy retains 2829 by default and permits only explicit 2828 or 2829', () => {
  assert.equal(resolveQaMarionettePort(2829), 2829);
  assert.equal(resolveQaMarionettePort('2829'), 2829);
  assert.equal(resolveQaMarionettePort(2828), 2828);
  assert.equal(resolveQaMarionettePort('2828'), 2828);
  for (const value of [0, 6000, 2830, '2828;exit', '02828', null, NaN]) {
    assert.throws(() => resolveQaMarionettePort(value), /refuses Marionette port/);
  }
});

test('normal Firefox launch prepares the current overlay after profile guard without enabling automation', () => {
  const source = fs.readFileSync(new URL('./run-firefox-mcp-target.sh', import.meta.url), 'utf8');
  const guarded = source.indexOf('validate-firefox-profile.mjs');
  const copied = source.indexOf('cp "$REPO_ROOT"/overlay/JS/*.uc.js');
  const normal = source.indexOf('if [[ "$LAUNCH_MODE" == normal ]]');
  assert.ok(guarded >= 0 && copied > guarded && normal > copied,
    'guarded preparation must run for both normal and automation launches');
  assert.match(source, /exec env -u MOZ_REMOTE_ALLOW_SYSTEM_ACCESS -u MOZ_MARIONETTE/);
  assert.match(source, /rm -rf "\$PROFILE\/startupCache"/);
});

test('semantic verifier refuses reserved 2829 before any MCP connection', (t) => {
  const source = fs.mkdtempSync(path.join(canonicalTempRoot(), 'egdesk-loader-fixture-'));
  t.after(() => removeCreatedTemp(source, 'egdesk-loader-fixture-'));
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(source, name), `loader fixture: ${name}\n`);
  const { profile } = bootstrapQaProfile({ loaderSource: source });
  t.after(() => removeCreatedTemp(profile, 'egdesk-chat-test-'));
  const outputDir = createQaEvidenceDirectory();
  t.after(() => removeCreatedTemp(outputDir, 'egdesk-chat-evidence-'));
  const verifier = new URL('./verify-semantic-zoom.mjs', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(verifier), '--profile', profile,
    '--port', '2829', '--output-dir', outputDir], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /2829 is reserved/);
  assert.deepEqual(fs.readdirSync(outputDir), [], 'rejected attach cannot create QA evidence or alter the old target');
});

test('QA result transport preserves shared Board records as JSON and retains thrown errors', () => {
  const record = { id: 'member-a', sourceRef: { kind: 'browser-url', uri: 'about:blank' } };
  const value = { projection: { members: [{ record }] }, members: [{ record }] };
  const decoded = decodeQaEvaluationResult(JSON.stringify({ qaEvaluation: 1, ok: true, value }));
  assert.deepEqual(decoded.projection.members[0].record, decoded.members[0].record);
  assert.notEqual(decoded.projection.members[0].record, decoded.members[0].record);
  assert.throws(() => decodeQaEvaluationResult({ qaEvaluation: 1, ok: true, value }), /JSON string/);
  assert.throws(() => decodeQaEvaluationResult(JSON.stringify({ qaEvaluation: 1, ok: false,
    error: { message: 'fixture failed', stack: 'fixture.js:12' } })), /fixture failed\nfixture.js:12/);
});

test('native scroll chooses a direction with room instead of Home at the top boundary', () => {
  assert.equal(chooseNativeScrollKey({ scrollTop: 0, scrollHeight: 1131, clientHeight: 429 }), 'PageDown');
  assert.equal(chooseNativeScrollKey({ scrollTop: 702, scrollHeight: 1131, clientHeight: 429 }), 'PageUp');
  assert.throws(() => chooseNativeScrollKey({ scrollTop: 0, scrollHeight: 429, clientHeight: 429 }), /no overflow/);
});

test('room selection resolves the requested local ID and exact label among multiple rows', () => {
  const a = { id: 'room-a', title: 'QA A run' };
  const b = { id: 'room-b', title: 'QA B run' };
  const rows = [{ title: b.title, visible: true, selector: '#b' },
    { title: a.title, visible: true, selector: '#a' }, { title: a.title, visible: true, selector: '#a-recent' }];
  assert.equal(chooseQaThreadRow(a, [a, b], rows).selector, '#a');
  assert.equal(chooseQaThreadRow(b, [a, b], rows).selector, '#b');
  assert.throws(() => chooseQaThreadRow({ ...a, id: 'wrong' }, [a, b], rows), /local ID/);
  assert.throws(() => chooseQaThreadRow(a, [a, { id: 'other', title: a.title }], rows), /not unique/);
  // A row below its list's edge is drawn under another control; only a row a native click can reach is chosen.
  const clipped = [{ title: a.title, visible: true, hittable: false, selector: '#a-clipped' }, { title: a.title, visible: true, hittable: true, selector: '#a-reachable' }];
  assert.equal(chooseQaThreadRow(a, [a, b], clipped).selector, '#a-reachable');
  assert.throws(() => chooseQaThreadRow(a, [a, b], clipped.slice(0, 1)), /clipped by its list/);
});

test('send readiness requires the complete draft and an enabled button in the same local room', () => {
  const input = { visible: true, value: 'QA request', dataset: { threadId: 'room-a' } };
  const button = { visible: true, disabled: false };
  assert.equal(composerIsReady(input, button, 'QA request', 'room-a'), true);
  assert.equal(composerIsReady(input, { ...button, disabled: true }, 'QA request', 'room-a'), false);
  assert.equal(composerIsReady({ ...input, value: 'Q' }, button, 'QA request', 'room-a'), false);
  assert.equal(composerIsReady(input, button, 'QA request', 'room-b'), false);
  assert.equal(composerIsReady(input, { ...button, visible: false }, 'QA request', 'room-a'), false);
});

test('Chat counts as open only when wholly on screen and clear of the Dock', () => {
  const box = (left, top, width, height) => ({ left, top, right: left + width, bottom: top + height, width, height });
  const view = { width: 1440, height: 900 };
  const dock = box(364, 842, 712, 46);
  assert.equal(chatShellUsable(box(557, 158, 407, 580), dock, view), true, 'a Chat inside the window above the Dock');
  assert.equal(chatShellUsable(box(491, 716, 407, 580), dock, view), false, 'camera left it behind: composer below the window');
  assert.equal(chatShellUsable(box(557, 300, 407, 580), dock, view), false, 'its composer sits behind the Dock');
  assert.equal(chatShellUsable(box(1257, 142, 407, 580), dock, view), false, 'cut off at the right edge');
  assert.equal(chatShellUsable(box(557, 158, 407, 580), null, view), true, 'no Dock to avoid');
  assert.equal(chatShellUsable(box(557, 158, 0, 580), dock, view), false, 'no size');
  assert.equal(chatShellUsable(null, dock, view), false, 'no Chat');
  assert.equal(chatShellUsable(box(557, 158, 407, 580), dock, { width: 0, height: 0 }), false, 'unknown window');
});
