import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
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
  resolveQaMarionettePort, serializeQaNativeInput, QA_NATIVE_INPUT_MAX_DELTA } from './firefox-mcp-chat-harness.mjs';
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

const POINT_CONTEXT = '12345678-1234-1234-1234-123456789abc';
const POINT_VIEWPORT = { context: POINT_CONTEXT, width: 800, height: 600 };

// Execute the real class/transport in a VM with an in-memory child and clock.
// No process, port, evidence directory, Firefox, or provider is created here.
function offlinePointHarness({ rawTool = true } = {}) {
  const profile = '/qa/egdesk-chat-test-offline';
  const state = { profile, calls: [], spawns: 0, holdInput: false, inputError: null,
    beforeEvaluate: null, viewport: { width: 800, height: 600 }, root: true,
    protocolSessions: 0, recoverBeforeInput: null, protocolContext: POINT_CONTEXT, protocolInputs: [] };
  const timers = new Map();
  let timerId = 0;
  const required = ['list_privileged_contexts', 'select_privileged_context', 'evaluate_privileged_script',
    'take_snapshot', 'clear_snapshot', 'click_by_uid', 'fill_by_uid', 'press_key', 'type_text', 'screenshot_page'];
  const textResult = text => ({ content: [{ type: 'text', text }] });
  const spawn = () => {
    state.spawns++;
    const child = new EventEmitter();
    state.child = child;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdout.destroy = child.stderr.destroy = child.unref = () => {};
    child.exitCode = child.signalCode = null;
    child.stdin = new EventEmitter();
    child.stdin.writable = true;
    child.stdin.end = () => { child.stdin.writable = false; child.exitCode = 0; child.emit('exit', 0, null); };
    child.stdin.write = line => {
      const request = JSON.parse(line);
      state.calls.push(request);
      if (!request.id) return true;
      Promise.resolve().then(async () => {
        let result = {};
        if (request.method === 'tools/list') result = { tools: [...required, ...(rawTool ? ['send_bidi_command'] : [])].map(name => ({ name })) };
        if (request.method === 'tools/call') {
          const { name, arguments: args } = request.params;
          if (name === 'list_privileged_contexts') {
            if (!state.protocolSessions) state.protocolSessions = 1;
            result = textResult(`${state.protocolContext}: chrome://browser/content/browser.xhtml`);
          }
          else if (name === 'evaluate_privileged_script') {
            assert.equal(args.context, POINT_CONTEXT);
            if (state.beforeEvaluate) await state.beforeEvaluate(args.function);
            const value = await runInNewContext(`(${args.function})()`, {
              Services: { dirsvc: { get: () => ({ path: state.profile }) } }, Ci: { nsIFile: {} },
              window: { document: { documentURI: 'chrome://browser/content/browser.xhtml' },
                innerWidth: state.viewport.width, innerHeight: state.viewport.height,
                docShell: { browsingContext: { isContent: !state.root, parent: null,
                  currentWindowGlobal: { isCurrentGlobal: true } } } },
            });
            result = { structuredContent: value };
          } else if (name === 'send_bidi_command') {
            // Model getFirefox recovery separately from the MCP child. Either
            // the original UUID still resolves or it is lost; never assume it
            // survives a real session replacement. No real connection occurs.
            if (state.recoverBeforeInput) {
              state.protocolSessions++;
              if (state.recoverBeforeInput === 'context-lost') state.protocolContext = '87654321-4321-4321-4321-cba987654321';
              state.recoverBeforeInput = null;
            }
            state.protocolInputs.push({ session: state.protocolSessions, ...structuredClone(args) });
            if (args.params.context !== state.protocolContext) {
              result = { isError: true, ...textResult('Error: BiDi error: "no such frame"') };
            } else {
              if (state.holdInput) return;
              result = state.inputError ? { isError: true, ...textResult(state.inputError) } : textResult('{}');
            }
          }
        }
        child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n'));
      }).catch(error => child.stdout.emit('data', Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: request.id,
        error: { message: error.message } }) + '\n')));
      return true;
    };
    return child;
  };
  const source = fs.readFileSync(new URL('./firefox-mcp-chat-harness.mjs', import.meta.url), 'utf8')
    .replace(/^import[\s\S]*?;\n/gm, '').replace(/^export /gm, '');
  const Harness = runInNewContext(`${source}\nFirefoxMcpChatHarness`, {
    Buffer, path, spawn,
    process: { platform: 'darwin', execPath: '/qa/node', env: {
      EGDESK_QA_MCP_ENTRY: '/qa/mcp.mjs', EGDESK_QA_GECKODRIVER: '/qa/geckodriver', PATH: '/qa' } },
    fs: { lstatSync: () => ({ isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false }),
      realpathSync: { native: value => value }, accessSync() {}, constants: { X_OK: 1 } },
    assertQaProfile: value => { assert.equal(value, profile); return value; },
    canonicalTempRoot: () => '/qa', createPrivateQaTempDirectory: () => '/qa/egdesk-chat-evidence-offline',
    isOwnedAndPrivate: () => true,
    setTimeout: callback => { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return { harness: new Harness({ profile }), state, timers,
    inputs: () => state.calls.filter(call => call.params?.name === 'send_bidi_command'),
    expire: () => { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } } };
}

async function flushPointTransport() {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

test('native point serializer emits only fixed-context pointer or wheel actions', () => {
  assert.deepEqual(serializeQaNativeInput('click', { x: 12.5, y: 20 }, POINT_VIEWPORT), {
    method: 'input.performActions', params: { context: POINT_CONTEXT, actions: [{
      type: 'pointer', id: 'egdesk_qa_point_mouse', parameters: { pointerType: 'mouse' }, actions: [
        { type: 'pointerMove', origin: 'viewport', x: 12.5, y: 20, duration: 0 },
        { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 },
      ],
    }] },
  });
  assert.deepEqual(serializeQaNativeInput('wheel', { x: 12, y: 20, deltaX: -30, deltaY: 240 }, POINT_VIEWPORT), {
    method: 'input.performActions', params: { context: POINT_CONTEXT, actions: [{
      type: 'wheel', id: 'egdesk_qa_point_wheel', actions: [
        { type: 'scroll', origin: 'viewport', x: 12, y: 20, deltaX: -30, deltaY: 240, duration: 0 },
      ],
    }] },
  });
});

test('native point serializer rejects invalid, out-of-viewport and unbounded inputs without coercion', () => {
  for (const point of [null, [], {}, { x: '1', y: 1 }, { x: NaN, y: 1 }, { x: Infinity, y: 1 },
    { x: -1, y: 1 }, { x: 800, y: 1 }, { x: 1, y: 600 }, { x: 1, y: 1, context: POINT_CONTEXT },
    { get x() { throw new Error('must not invoke getter'); }, y: 1 }]) {
    assert.throws(() => serializeQaNativeInput('click', point, POINT_VIEWPORT), /Native|native/);
  }
  for (const point of [{ x: 1.5, y: 1, deltaX: 0, deltaY: 1 }, { x: 1, y: 1, deltaX: 0, deltaY: 0 },
    { x: 1, y: 1, deltaX: 0, deltaY: 1.5 }, { x: 1, y: 1, deltaX: Infinity, deltaY: 1 },
    { x: 1, y: 1, deltaX: 0, deltaY: QA_NATIVE_INPUT_MAX_DELTA + 1 }]) {
    assert.throws(() => serializeQaNativeInput('wheel', point, POINT_VIEWPORT), /Wheel|finite/);
  }
  for (const viewport of [{ ...POINT_VIEWPORT, context: 'other' }, { ...POINT_VIEWPORT, width: 0 },
    { ...POINT_VIEWPORT, height: NaN }, { ...POINT_VIEWPORT, width: Infinity }]) {
    assert.throws(() => serializeQaNativeInput('click', { x: 1, y: 1 }, viewport), /context|viewport/);
  }
  assert.doesNotThrow(() => serializeQaNativeInput('wheel',
    { x: 799, y: 599, deltaX: -QA_NATIVE_INPUT_MAX_DELTA, deltaY: QA_NATIVE_INPUT_MAX_DELTA }, POINT_VIEWPORT));
});

test('real harness point methods clone before await and profile-check before each single MCP input request', async () => {
  const fake = offlinePointHarness();
  await fake.harness.connect();
  const point = { x: 10.5, y: 20 };
  const pending = fake.harness.clickPoint(point);
  point.x = 700;
  await pending;
  await fake.harness.wheelAt({ x: 30, y: 40, deltaX: 0, deltaY: -120 });
  assert.equal(fake.inputs().length, 2);
  assert.deepEqual(fake.inputs()[0].params.arguments, serializeQaNativeInput('click', { x: 10.5, y: 20 }, POINT_VIEWPORT));
  assert.deepEqual(fake.inputs()[1].params.arguments, serializeQaNativeInput('wheel', { x: 30, y: 40, deltaX: 0, deltaY: -120 }, POINT_VIEWPORT));
  for (const input of fake.inputs()) {
    const before = fake.state.calls[fake.state.calls.indexOf(input) - 1];
    assert.equal(before.params.name, 'evaluate_privileged_script');
    assert.match(before.params.arguments.function, /ProfD/);
    assert.doesNotMatch(before.params.arguments.function, /qaEvaluation/);
    assert.equal(before.params.arguments.context, POINT_CONTEXT);
  }
  assert.equal(fake.state.spawns, 1);
  assert.equal(fake.timers.size, 0);
  await fake.harness.close();
});

test('point input refuses absent tool without breaking legacy connection or trying another input', async () => {
  const fake = offlinePointHarness({ rawTool: false });
  await fake.harness.connect();
  const baseline = fake.state.calls.length;
  await assert.rejects(fake.harness.clickPoint({ x: 1, y: 1 }), /lacks native input tool/);
  await assert.rejects(fake.harness.wheelAt({ x: 1, y: 1, deltaX: 0, deltaY: 1 }), /lacks native input tool/);
  assert.equal(fake.state.calls.length, baseline);
  await fake.harness.press('Escape');
  assert.equal(fake.state.calls.at(-1).params.name, 'press_key');
  await fake.harness.close();
});

test('point input fails before dispatch for early, observation-time and final profile mismatch', async () => {
  for (const phase of ['early', 'observation', 'final']) {
    const fake = offlinePointHarness();
    await fake.harness.connect();
    let profileReads = 0;
    if (phase === 'early') fake.state.profile = '/qa/other-profile';
    else fake.state.beforeEvaluate = source => {
      if (!source.includes('qaEvaluation')) profileReads++;
      if ((phase === 'observation' && source.includes('qaEvaluation')) ||
          (phase === 'final' && profileReads === 2)) fake.state.profile = '/qa/other-profile';
    };
    await assert.rejects(fake.harness.clickPoint({ x: 1, y: 1 }), /different.*profile/i);
    assert.equal(fake.inputs().length, 0);
    assert.equal(fake.state.spawns, 1);
    await fake.harness.close();
  }
});

test('point input refuses an MCP transport lost during the viewport observation', async () => {
  const fake = offlinePointHarness();
  await fake.harness.connect();
  fake.state.beforeEvaluate = source => {
    if (source.includes('qaEvaluation')) fake.state.child.stdin.writable = false;
  };
  await assert.rejects(fake.harness.clickPoint({ x: 1, y: 1 }), /connection\/context/);
  assert.equal(fake.inputs().length, 0);
  assert.equal(fake.state.spawns, 1);
  await fake.harness.close();
});

test('point input refuses invalid data before any read and stale root/outside viewport before any input', async () => {
  const fake = offlinePointHarness();
  await fake.harness.connect();
  const baseline = fake.state.calls.length;
  await assert.rejects(fake.harness.clickPoint({ x: NaN, y: 1 }), /finite/);
  assert.equal(fake.state.calls.length, baseline);
  await assert.rejects(fake.harness.clickPoint({ x: 800, y: 1 }), /viewport/);
  fake.state.root = false;
  await assert.rejects(fake.harness.wheelAt({ x: 1, y: 1, deltaX: 0, deltaY: 1 }), /non-root/);
  assert.equal(fake.inputs().length, 0);
  await fake.harness.close();
  await assert.rejects(fake.harness.clickPoint({ x: 1, y: 1 }), /connection\/context/);
});

test('point input timeout sends once with no harness retry, fallback, reconnect or release action', async () => {
  for (const method of ['clickPoint', 'wheelAt']) {
    const fake = offlinePointHarness();
    await fake.harness.connect();
    const baseline = fake.state.calls.length;
    fake.state.holdInput = true;
    fake.state.recoverBeforeInput = 'original-context';
    const pending = fake.harness[method](method === 'clickPoint' ? { x: 1, y: 1 } : { x: 1, y: 1, deltaX: 0, deltaY: 100 });
    const rejected = assert.rejects(pending, /timed out.*never retried/);
    await flushPointTransport();
    assert.equal(fake.inputs().length, 1);
    assert.equal(fake.timers.size, 1);
    fake.expire();
    await rejected;
    await flushPointTransport();
    assert.equal(fake.inputs().length, 1);
    assert.equal(fake.state.spawns, 1);
    assert.equal(fake.state.protocolSessions, 2, 'pre-dispatch protocol recovery is not input replay');
    assert.equal(fake.state.protocolInputs.length, 1);
    assert.equal(fake.state.protocolInputs[0].params.context, POINT_CONTEXT);
    assert.deepEqual(fake.state.calls.slice(baseline).map(call => call.params.name), [
      'evaluate_privileged_script', 'evaluate_privileged_script', 'evaluate_privileged_script', 'send_bidi_command',
    ]);
    assert.equal(fake.timers.size, 0);
    await fake.harness.close();
  }
});

test('protocol recovery retaining the original UUID sends unchanged input once without restarting MCP', async () => {
  for (const [method, kind, point] of [
    ['clickPoint', 'click', { x: 15, y: 20 }],
    ['wheelAt', 'wheel', { x: 15, y: 20, deltaX: 0, deltaY: 120 }],
  ]) {
    const fake = offlinePointHarness();
    await fake.harness.connect();
    const baseline = fake.state.calls.length;
    fake.state.recoverBeforeInput = 'original-context';
    await fake.harness[method](point);
    const payload = serializeQaNativeInput(kind, point, POINT_VIEWPORT);
    assert.equal(fake.state.spawns, 1, 'MCP child identity is not protocol-session identity');
    assert.equal(fake.state.protocolSessions, 2);
    assert.deepEqual(fake.state.protocolInputs, [{ session: 2, ...payload }]);
    assert.equal(fake.inputs().length, 1);
    assert.deepEqual(fake.inputs()[0].params.arguments, payload);
    assert.deepEqual(fake.state.calls.slice(baseline).map(call => call.params.name), [
      'evaluate_privileged_script', 'evaluate_privileged_script', 'evaluate_privileged_script', 'send_bidi_command',
    ]);
    assert.equal(fake.timers.size, 0);
    await fake.harness.close();
  }
});

test('protocol recovery losing the original UUID fails with no retarget, second input or ambiguous replay', async () => {
  for (const [method, kind, point] of [
    ['clickPoint', 'click', { x: 15, y: 20 }],
    ['wheelAt', 'wheel', { x: 15, y: 20, deltaX: 0, deltaY: 120 }],
  ]) {
    const fake = offlinePointHarness();
    await fake.harness.connect();
    const baseline = fake.state.calls.length;
    fake.state.recoverBeforeInput = 'context-lost';
    await assert.rejects(fake.harness[method](point), /no such frame/);
    await flushPointTransport();
    const payload = serializeQaNativeInput(kind, point, POINT_VIEWPORT);
    assert.equal(fake.state.spawns, 1);
    assert.equal(fake.state.protocolSessions, 2);
    assert.notEqual(fake.state.protocolContext, POINT_CONTEXT);
    assert.deepEqual(fake.state.protocolInputs, [{ session: 2, ...payload }]);
    assert.equal(fake.inputs().length, 1);
    assert.deepEqual(fake.inputs()[0].params.arguments, payload);
    assert.deepEqual(fake.state.calls.slice(baseline).map(call => call.params.name), [
      'evaluate_privileged_script', 'evaluate_privileged_script', 'evaluate_privileged_script', 'send_bidi_command',
    ], 'no context lookup/selection, fallback input, or retry follows failure');
    assert.equal(fake.timers.size, 0);
    await fake.harness.close();
  }
});

test('point input propagates stale/invalid MCP failure without the selector API retry', async () => {
  const fake = offlinePointHarness();
  await fake.harness.connect();
  fake.state.inputError = 'Error: stale/invalid native input';
  await assert.rejects(fake.harness.clickPoint({ x: 1, y: 1 }), /stale\/invalid/);
  await flushPointTransport();
  assert.equal(fake.inputs().length, 1);
  assert.equal(fake.timers.size, 0);
  assert.equal(fake.state.spawns, 1);
  await fake.harness.close();
});

test('omitting the loader source fails before looking for files in a personal Firefox profile', () => {
  assert.throws(() => bootstrapQaProfile(), /explicit dedicated loader source/);
  assert.throws(() => bootstrapQaProfile({ loaderSource: 'chrome/utils' }), /explicit dedicated loader source/);
});

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

test('QA port policy retains 2829 by default and permits only explicit 2828, 2829, 28831, 28832 or 28833', () => {
  assert.equal(resolveQaMarionettePort(2829), 2829);
  assert.equal(resolveQaMarionettePort('2829'), 2829);
  assert.equal(resolveQaMarionettePort(2828), 2828);
  assert.equal(resolveQaMarionettePort('2828'), 2828);
  assert.equal(resolveQaMarionettePort(28831), 28831);
  assert.equal(resolveQaMarionettePort('28831'), 28831);
  assert.equal(resolveQaMarionettePort(28832), 28832);
  assert.equal(resolveQaMarionettePort('28832'), 28832);
  assert.equal(resolveQaMarionettePort(28833), 28833);
  assert.equal(resolveQaMarionettePort('28833'), 28833);
  for (const value of [0, 6000, 2830, 28834, '28833;exit', '028833', '28832;exit', '028832', '2828;exit', '02828', null, NaN]) {
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
