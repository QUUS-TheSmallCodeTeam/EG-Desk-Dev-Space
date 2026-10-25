// QA copies only. No product preference, global port substitution or listener.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertQaFixtureManifest, qaProfileSourceFingerprints } from './egdesk-chat-qa-profile.mjs';
import { isOwnedAndPrivate } from './egdesk-qa-platform.mjs';
import { chatRunOutputsFixtureEnabled } from './egdesk-chat-run-outputs-fixture.mjs';

export const QA_ISOLATION_MANIFEST = '.egdesk-qa-fixture-isolation.json';
export const QA_PROJECT_PICKER_FILE = 'resources/surface/EGDeskSurfaceFileCard.mjs';
export const QA_RUN_OUTPUTS_FILES = Object.freeze([
  'resources/EGDeskChatRunResult.sys.mjs', 'resources/EGDeskChatChangeReview.sys.mjs',
  'resources/EGDeskRunResult.sys.mjs', 'resources/EGDeskDiffView.sys.mjs', 'resources/EGDeskChangeReview.mjs',
]);
const OVERLAY = fileURLToPath(new URL('../overlay/', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`QA fixture isolation: ${message}`); };

export function qaBridgeConfig(env = process.env) {
  // prepareQaFirefox calls this before copying files or writing preferences.
  // Reuse the data-only sidecar gate (no dependency back to isolation), then
  // exclude Claude here as well as at the transport boundary.
  const runOutputsFixture = chatRunOutputsFixtureEnabled(env);
  if (runOutputsFixture && env.EGDESK_QA_CLAUDE_FIXTURE === '1') fail('run outputs require a separate fixture mode from Claude');
  const flag = env.EGDESK_QA_FIXTURE_TRANSPORT;
  if (flag != null && flag !== '0' && flag !== '1') fail('invalid fixture mode');
  const fixture = flag === '1', value = env.EGDESK_QA_FIXTURE_PORT;
  if (!fixture) {
    if (value != null) fail('EGDESK_QA_FIXTURE_PORT requires fixture mode');
    return { fixture: false, host: '127.0.0.1', port: 39218, origin: 'http://127.0.0.1:39218' };
  }
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,4}$/.test(value)
      || Number(value) > 65535 || Number(value) === 39218) {
    fail('explicit EGDESK_QA_FIXTURE_PORT must be a valid port other than 39218');
  }
  return { fixture: true, host: '127.0.0.1', port: Number(value), origin: `http://127.0.0.1:${value}` };
}

export function qaBridgeUrl(route, env = process.env) {
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//')
      || /[\\\u0000-\u0020\u007f]/.test(route)) fail('expected a loopback bridge route');
  const { origin } = qaBridgeConfig(env);
  const url = new URL(route, origin);
  if (url.origin !== origin || url.username || url.password) fail('route escaped loopback');
  return url.href;
}

function infoOrNull(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function safeFile(file, root) {
  if (!file.startsWith(root + path.sep)) fail('file escaped QA root');
  for (let current = file; current !== root; current = path.dirname(current)) {
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink() || fs.realpathSync.native(current) !== current
        || !isOwnedAndPrivate(current, info) || (current === file
          ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())) {
      fail(`noncanonical, linked or unowned file: ${file}`);
    }
  }
  return fs.readFileSync(file);
}

export function assertFreshQaFixtureProfile(profilePath) {
  const { profile } = assertQaFixtureManifest(profilePath);
  for (const name of ['parent.lock', '.parentlock', 'lock']) {
    if (infoOrNull(path.join(profile, name))) fail('locked QA profile');
  }
  // A bootstrap may seed prefs.js for recovery, but an already-used Firefox
  // profile is never an endpoint-rewrite target, even after Firefox exits.
  for (const name of ['compatibility.ini', 'times.json', 'places.sqlite', 'cookies.sqlite',
    'sessionstore.jsonlz4', 'sessionstore-backups', 'startupCache']) {
    if (infoOrNull(path.join(profile, name))) fail('only a new, unused QA profile copy may be materialized');
  }
  return profile;
}

// Full URL literals (including the ${path} boundary), not arbitrary 39218 text.
const ENDPOINT_RULES = Object.freeze({
  'JS/eg-desk-surface.uc.js': [
    "'http://127.0.0.1:39218/system/resources'",
    '`http://127.0.0.1:39218${path}`',
    "'http://127.0.0.1:39218/events?chatProtocol=2'",
  ],
  'resources/surface/EGDeskSurfaceFileCard.mjs': ['`http://127.0.0.1:39218${path}`'],
});
const CONSTANT_RULES = Object.freeze({
  'JS/eg-desk-surface.uc.js': ['const EGDESK_HELPER_PORT = 39218;'],
  'resources/surface/EGDeskSurfaceTerminal.mjs': ['const EGDESK_HELPER_PORT = 39218;'],
  'resources/egdesk-terminal-init.js': ['const HELPER_PORT = 39218;'],
});

export function projectFileFixtureEnabled(env = process.env) {
  const flag = env.EGDESK_QA_PROJECT_FILE_FIXTURE;
  if (flag != null && flag !== '0' && flag !== '1') fail('invalid project File fixture opt-in');
  if (flag !== '1') return false;
  if (env.EGDESK_QA_FIXTURE_TRANSPORT !== '1' || env.EGDESK_QA_REAL_TURN !== '0'
      || env.EGDESK_QA_CLAUDE_FIXTURE === '1') fail('project File fixture requires isolated, model-free transport');
  return true;
}

// Replace only the OS directory result. The shipped picker handshake, File
// service, project attachment and FileView remain byte-identical. No globals,
// function overrides after launch, or direct openProject calls are installed.
export function transformProjectPickerResult(original, port) {
  qaBridgeConfig({ EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_FIXTURE_PORT: String(port) });
  const start = '  function pickNativeFileDirectory() {';
  const end = '  function pickNativeFileSaveFile(';
  if (original.split(start).length !== 2 || original.split(end).length !== 2) {
    fail('project picker result seam is missing or ambiguous');
  }
  const from = original.indexOf(start), to = original.indexOf(end);
  const before = original.slice(from, to);
  if (to <= from || !before.includes("Cc['@mozilla.org/filepicker;1'].createInstance(Ci.nsIFilePicker)")
      || !before.includes('Ci.nsIFilePicker.modeGetFolder') || !before.includes('picker.file.path')) {
    fail('project picker OS result boundary changed');
  }
  const replacement = `  function pickNativeFileDirectory() {
    // Explicit, fingerprinted QA copy: only the OS folder result is synthetic.
    return fetch('http://127.0.0.1:${port}/__qa/project-file/picker', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    }).then(async response => {
      const packet = await response.json();
      if (!response.ok || packet?.kind !== 'egdesk-project-file-picker-result'
          || packet.synthetic !== true || !(packet.selection === null
          || (typeof packet.selection === 'string' && packet.selection.startsWith('/')))) {
        throw new Error('Owned QA picker result is unavailable; native picker is never a fallback');
      }
      return packet.selection;
    });
  }

`;
  return { text: original.slice(0, from) + replacement + original.slice(to),
    descriptor: { kind: 'project-file-os-directory-result-v1',
      sourceBoundarySha256: sha256(before), replacementSha256: sha256(replacement),
      synthetic: 'OS-picker-result-only', nativePickerInvocations: 0,
      endpoint: `http://127.0.0.1:${port}/__qa/project-file/picker` } };
}

export function transformQaFixtureSource(name, original, port, { projectFileFixture = false } = {}) {
  qaBridgeConfig({ EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_FIXTURE_PORT: String(port) });
  let text = original;
  const replacements = { endpointUrls: 0, helperPortConstants: 0 };
  for (const [rules, key] of [[ENDPOINT_RULES, 'endpointUrls'], [CONSTANT_RULES, 'helperPortConstants']]) {
    for (const literal of rules[name] || []) {
      const count = text.split(literal).length - 1;
      text = text.split(literal).join(literal.replace('39218', String(port)));
      replacements[key] += count;
    }
  }
  // New endpoint syntax must be explicitly reviewed; never leave a live bridge
  // endpoint behind or silently expand the replacement allowlist.
  if (/https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):39218\b|\b(?:EGDESK_)?HELPER_PORT\s*=\s*39218\b/.test(text)) {
    fail(`unapproved production endpoint remains in ${name}`);
  }
  if (projectFileFixture && name === QA_PROJECT_PICKER_FILE) {
    const transformed = transformProjectPickerResult(text, port);
    return { text: transformed.text, replacements: { ...replacements, osPickerResultBoundaries: 1 },
      projectPickerTransform: transformed.descriptor };
  }
  return { text, replacements };
}

function expectedFiles(profile, port, projectFileFixture = false, runOutputsFixture = false) {
  const files = {};
  const fingerprints = qaProfileSourceFingerprints(profile);
  if (projectFileFixture) {
    for (const name of ['resources/EGDeskFileView.sys.mjs', 'resources/EGDeskFileCardState.sys.mjs',
      'resources/EGDeskRunResult.sys.mjs', 'resources/EGDeskDiffView.sys.mjs', 'resources/EGDeskChangeReview.mjs']) {
      fingerprints[name] = sha256(safeFile(path.join(profile, 'chrome', name), profile));
    }
  }
  if (runOutputsFixture) for (const name of QA_RUN_OUTPUTS_FILES) {
    fingerprints[name] = sha256(safeFile(path.join(profile, 'chrome', name), profile));
  }
  for (const [name, copyHash] of Object.entries(fingerprints)) {
    const source = path.join(OVERLAY, name), sourceInfo = infoOrNull(source);
    if (!sourceInfo && copyHash === null) continue;
    if (!sourceInfo || copyHash === null) fail(`overlay copy/source missing: ${name}`);
    const original = safeFile(source, path.resolve(OVERLAY));
    const transformed = transformQaFixtureSource(name, original.toString('utf8'), port, { projectFileFixture });
    files[name] = { originalSha256: sha256(original), transformedSha256: sha256(transformed.text),
      replacements: transformed.replacements,
      ...(transformed.projectPickerTransform ? { projectPickerTransform: transformed.projectPickerTransform } : {}) };
  }
  if (!files['JS/eg-desk-surface.uc.js']?.replacements.endpointUrls) fail('missing surface bridge endpoints');
  if (projectFileFixture && !files[QA_PROJECT_PICKER_FILE]?.projectPickerTransform) fail('missing project picker transform fingerprint');
  return files;
}

function readManifest(profile) {
  const file = path.join(profile, QA_ISOLATION_MANIFEST);
  return JSON.parse(safeFile(file, profile).toString('utf8'));
}

function checkManifest(manifest, profile, config, files) {
  if (manifest.kind !== 'egdesk-qa-fixture-isolation-v1' || manifest.profile !== profile
      || manifest.host !== config.host || manifest.port !== config.port
      || manifest.origin !== config.origin || manifest.qaOnly !== true
      || JSON.stringify(manifest.files) !== JSON.stringify(files)) {
    fail('profile/port/source/provenance manifest mismatch');
  }
}

export function validateQaFixtureIsolation(profilePath, { env = process.env, requireFresh = false } = {}) {
  const config = qaBridgeConfig(env);
  if (!config.fixture) fail('fixture mode is required');
  const { profile } = assertQaFixtureManifest(profilePath);
  if (requireFresh) assertFreshQaFixtureProfile(profile);
  const files = expectedFiles(profile, config.port, projectFileFixtureEnabled(env), chatRunOutputsFixtureEnabled(env)), manifest = readManifest(profile);
  checkManifest(manifest, profile, config, files);
  for (const [name, entry] of Object.entries(files)) {
    if (sha256(safeFile(path.join(profile, 'chrome', name), profile)) !== entry.transformedSha256) {
      fail(`transformed hash mismatch: ${name}`);
    }
  }
  return manifest;
}

export function assertQaProfileBridge(profilePath, env = process.env) {
  const config = qaBridgeConfig(env);
  if (config.fixture) return validateQaFixtureIsolation(profilePath, { env });
  const { profile } = assertQaFixtureManifest(profilePath);
  if (infoOrNull(path.join(profile, QA_ISOLATION_MANIFEST))) fail('isolated fixture profile cannot use the real-provider bridge');
  return null;
}

export function materializeQaFixtureIsolation(profilePath, { env = process.env } = {}) {
  const config = qaBridgeConfig(env);
  if (!config.fixture) fail('fixture mode is required');
  const profile = assertFreshQaFixtureProfile(profilePath);
  const projectFileFixture = projectFileFixtureEnabled(env);
  const files = expectedFiles(profile, config.port, projectFileFixture, chatRunOutputsFixtureEnabled(env));
  const manifestPath = path.join(profile, QA_ISOLATION_MANIFEST);
  const existing = infoOrNull(manifestPath) ? readManifest(profile) : null;
  if (existing) checkManifest(existing, profile, config, files);
  const writes = [];
  // Complete validation before the first write. Re-applying to the same copy,
  // or to a freshly recopied original overlay, has identical provenance.
  for (const [name, entry] of Object.entries(files)) {
    const destination = path.join(profile, 'chrome', name);
    const currentHash = sha256(safeFile(destination, profile));
    if (currentHash === entry.transformedSha256 && (existing || currentHash === entry.originalSha256)) continue;
    if (currentHash !== entry.originalSha256) fail(`not an unchanged overlay copy: ${name}`);
    const original = safeFile(path.join(OVERLAY, name), path.resolve(OVERLAY));
    if (sha256(original) !== entry.originalSha256) fail('source changed during materialization');
    writes.push([destination, transformQaFixtureSource(name, original.toString('utf8'), config.port, { projectFileFixture }).text]);
  }
  for (const [destination, text] of writes) fs.writeFileSync(destination, text);
  const manifest = { kind: 'egdesk-qa-fixture-isolation-v1', qaOnly: true, profile,
    host: config.host, port: config.port, origin: config.origin, files };
  if (!existing) fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return validateQaFixtureIsolation(profile, { env, requireFresh: true });
}
