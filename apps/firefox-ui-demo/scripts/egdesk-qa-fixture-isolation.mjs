// QA copies only. No product preference, global port substitution or listener.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { assertQaFixtureManifest, qaProfileSourceFingerprints } from './egdesk-chat-qa-profile.mjs';
import { isOwnedAndPrivate } from './egdesk-qa-platform.mjs';

export const QA_ISOLATION_MANIFEST = '.egdesk-qa-fixture-isolation.json';
const OVERLAY = fileURLToPath(new URL('../overlay/', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`QA fixture isolation: ${message}`); };

export function qaBridgeConfig(env = process.env) {
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

export function transformQaFixtureSource(name, original, port) {
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
  return { text, replacements };
}

function expectedFiles(profile, port) {
  const files = {};
  for (const [name, copyHash] of Object.entries(qaProfileSourceFingerprints(profile))) {
    const source = path.join(OVERLAY, name), sourceInfo = infoOrNull(source);
    if (!sourceInfo && copyHash === null) continue;
    if (!sourceInfo || copyHash === null) fail(`overlay copy/source missing: ${name}`);
    const original = safeFile(source, path.resolve(OVERLAY));
    const transformed = transformQaFixtureSource(name, original.toString('utf8'), port);
    files[name] = { originalSha256: sha256(original), transformedSha256: sha256(transformed.text),
      replacements: transformed.replacements };
  }
  if (!files['JS/eg-desk-surface.uc.js']?.replacements.endpointUrls) fail('missing surface bridge endpoints');
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
  const files = expectedFiles(profile, config.port), manifest = readManifest(profile);
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
  const files = expectedFiles(profile, config.port);
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
    writes.push([destination, transformQaFixtureSource(name, original.toString('utf8'), config.port).text]);
  }
  for (const [destination, text] of writes) fs.writeFileSync(destination, text);
  const manifest = { kind: 'egdesk-qa-fixture-isolation-v1', qaOnly: true, profile,
    host: config.host, port: config.port, origin: config.origin, files };
  if (!existing) fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  return validateQaFixtureIsolation(profile, { env, requireFresh: true });
}
