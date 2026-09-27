import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { assertQaProfile, bootstrapQaProfile, canonicalTempRoot,
  assertQaFixtureManifest, LOADER_FILES, QA_MARKER_BYTES, QA_MARKER_NAME,
  QA_FIXTURE_DIRECTORY, QA_FIXTURE_FILE, QA_FIXTURE_MANIFEST, QA_REAL_TURN_DIRECTORY, QA_BACKEND_DATA_DIRECTORY, deskRecoveryFixture } from './egdesk-chat-qa-profile.mjs';
import { assertQaEvidenceDirectory, chooseNativeScrollKey, contextIdFromList, createQaEvidenceDirectory, firstSnapshotUid,
  decodeQaEvaluationResult, FirefoxMcpChatHarness, mcpResultText, parseMcpJson } from './firefox-mcp-chat-harness.mjs';
import { assertQaFixtureArtifact } from './egdesk-chat-qa-contract.sys.mjs';
import { chooseQaThreadRow, composerIsReady } from './egdesk-qa-ui-flow.mjs';

function removeCreatedTemp(directory, prefix) {
  if (path.dirname(directory) !== canonicalTempRoot() || !path.basename(directory).startsWith(prefix)) {
    throw new Error(`Refusing test cleanup outside owned temp prefix: ${directory}`);
  }
  fs.rmSync(directory, { recursive: true, force: false });
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
  fs.symlinkSync(path.join(source, LOADER_FILES[0]), result.fixtureArtifact);
  assert.throws(() => assertQaFixtureManifest(result.profile), /regular files/);
});

test('QA profile guard rejects bad marker bytes, writable marker, and symlink alias', (t) => {
  const profile = fs.mkdtempSync(path.join(canonicalTempRoot(), 'egdesk-chat-test-'));
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
  fs.chmodSync(marker, 0o622);
  assert.throws(() => assertQaProfile(profile), /user-owned regular file/);
  fs.chmodSync(marker, 0o600);
  fs.symlinkSync(profile, alias);
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
  fs.chmodSync(evidence, 0o722);
  assert.throws(() => assertQaEvidenceDirectory(evidence), /safe canonical/);
  fs.chmodSync(evidence, 0o700);
  assert.equal(FirefoxMcpChatHarness.prototype.call, undefined);
  assert.equal(FirefoxMcpChatHarness.prototype.request, undefined);
  assert.equal(typeof FirefoxMcpChatHarness.prototype.evaluateChrome, 'function');
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
