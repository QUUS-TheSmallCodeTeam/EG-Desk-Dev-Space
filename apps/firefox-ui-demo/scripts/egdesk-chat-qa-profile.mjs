import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPrivateQaTempDirectory, isOwnedAndPrivate } from './egdesk-qa-platform.mjs';

export const QA_PROFILE_PREFIX = 'egdesk-chat-test-';
export const QA_MARKER_NAME = '.egdesk-dedicated-firefox-profile';
export const QA_MARKER_BYTES = Buffer.from('EGDESK_DEDICATED_FIREFOX_PROFILE_V1\n');
export const QA_FIXTURE_DIRECTORY = 'qa-fixtures';
export const QA_FIXTURE_FILE = 'fixture-reference.txt';
export const QA_FIXTURE_MANIFEST = 'manifest.json';
export const QA_REAL_TURN_DIRECTORY = 'real-turn';
export const QA_BACKEND_DATA_DIRECTORY = 'backend-data';
export const LOADER_FILES = Object.freeze([
  'boot.sys.mjs',
  'chrome.manifest',
  'fs.sys.mjs',
  'module_loader.mjs',
  'uc_api.sys.mjs',
  'utils.sys.mjs',
]);

export const DEFAULT_LOADER_SOURCE = path.join(
  os.homedir(),
  'Library/Application Support/Firefox/Profiles/egtc3irr.egdesk.default-release/chrome/utils',
);

export const QA_STAGE1_MODULES = Object.freeze([
  'resources/surface/EGDeskSurfaceOntology.mjs',
  'resources/surface/EGDeskSurfaceFileCard.mjs',
  'resources/surface/EGDeskSurfaceTerminal.mjs',
]);

function refuse(reason) {
  throw new Error(`Refusing EG-Desk QA profile: ${reason}`);
}

function isAncestor(candidate, target) {
  return candidate === target || target.startsWith(`${candidate}${path.sep}`);
}

export function canonicalTempRoot() {
  return fs.realpathSync.native(os.tmpdir());
}

export function qaProfileSourceFingerprints(profilePath) {
  const profile = assertQaProfile(profilePath);
  const names = ['JS/eg-desk-surface.uc.js', 'CSS/eg-desk-surface.uc.css',
    'resources/EGDeskSurfaceState.sys.mjs', 'resources/EGDeskRecoveryState.sys.mjs',
    'resources/EGDeskChatState.sys.mjs', 'resources/EGDeskTerminalState.sys.mjs', 'resources/terminal.html',
    'resources/egdesk-terminal-init.js', 'resources/EGDeskMarkdown.sys.mjs',
    'resources/EGDeskInputContext.sys.mjs', 'resources/EGDeskBriefingState.sys.mjs',
    'resources/EGDeskBrowserAgentRuntimeParent.sys.mjs', 'resources/EGDeskBrowserAgentRuntimeChild.sys.mjs',
    ...QA_STAGE1_MODULES];
  const surfaceFile = path.join(profile, 'chrome', names[0]);
  if (fs.existsSync(surfaceFile) && (fs.realpathSync.native(surfaceFile) !== surfaceFile
      || !fs.lstatSync(surfaceFile).isFile())) throw new Error('Profile source fingerprint refused a noncanonical file');
  const surface = fs.existsSync(surfaceFile) ? fs.readFileSync(surfaceFile, 'utf8') : '';
  return Object.fromEntries(names.map(name => {
    const file = path.join(profile, 'chrome', name);
    if (!fs.existsSync(file)) {
      if (QA_STAGE1_MODULES.includes(name) && surface.includes(path.basename(name))) {
        throw new Error(`Declared QA profile module is missing: ${name}`);
      }
      return [name, null];
    }
    if (fs.realpathSync.native(file) !== file || !fs.lstatSync(file).isFile()) throw new Error('Profile source fingerprint refused a noncanonical file');
    return [name, createHash('sha256').update(fs.readFileSync(file)).digest('hex')];
  }));
}

export function deskRecoveryFixture(kind) {
  const prefName = 'egdesk.deskSession.v1';
  if (kind === 'corrupt') return { kind, prefName, raw: '{"version":1,"agenda":' };
  if (kind !== 'partial') throw new Error('Desk recovery fixture must be corrupt or partial');
  return { kind, prefName, raw: JSON.stringify({
    version: 1, savedAt: 1700000000000,
    agenda: { id: 'qa-partial-desk', title: 'QA partial Desk recovery', memberCardIds: ['qa-preserved-view'] },
    surface: { mode: 'desk', browserCardId: 'qa-preserved-view' },
    desk: { pan: { x: 0, y: 0 }, zoom: 1, activeCardId: 'qa-preserved-view' },
    cards: [{ id: 'qa-preserved-view', type: 'browser',
      geometry: { x: 40, y: 80, width: 480, height: 320 },
      sourceRef: { kind: 'browser-url', uri: 'about:blank' }, runtimeState: { uri: 'about:blank' } }],
    // The card schema is valid so restoration can begin. The malformed
    // projection exercises failure after that first view has been mounted.
    shapes: [], boardProjections: { projections: { 'qa-partial-projection': {
      id: 'qa-partial-projection', boardId: 'qa-partial-board', title: 'QA partial projection', members: null,
    } }, activeProjectionId: null },
  }) };
}

// This is intentionally stricter than the production profile guard: QA must
// never attach to its grandfathered real-user profile.
export function assertQaProfile(profilePath) {
  if (typeof profilePath !== 'string' || !path.isAbsolute(profilePath) || /[\r\n]/.test(profilePath)) {
    refuse('an absolute profile path is required');
  }
  if (path.resolve(profilePath) !== profilePath) refuse('path must be normalized');
  const info = fs.lstatSync(profilePath);
  if (!info.isDirectory() || info.isSymbolicLink()) refuse('profile must be a real directory');
  if (!isOwnedAndPrivate(profilePath, info)) {
    refuse('profile must be user-owned and not group/world writable');
  }
  const canonical = fs.realpathSync.native(profilePath);
  if (canonical !== profilePath) refuse('use the canonical path, not a symlinked path');
  if (!path.basename(canonical).startsWith(QA_PROFILE_PREFIX) || path.dirname(canonical) !== canonicalTempRoot()) {
    refuse('profile must be a direct egdesk-chat-test-* child of the canonical temp directory');
  }
  const homes = [os.homedir(), os.userInfo().homedir].map(home => fs.realpathSync.native(home));
  if (canonical === path.parse(canonical).root || homes.some(home => isAncestor(canonical, home))) {
    refuse('root, home, or an ancestor of home is not a QA profile');
  }
  const markerPath = path.join(canonical, QA_MARKER_NAME);
  const markerInfo = fs.lstatSync(markerPath);
  if (!markerInfo.isFile() || markerInfo.isSymbolicLink() ||
      !isOwnedAndPrivate(markerPath, markerInfo) ||
      !fs.readFileSync(markerPath).equals(QA_MARKER_BYTES)) {
    refuse('marker must be a user-owned regular file with the exact V1 bytes');
  }
  // These in-process checks are stricter than validate-firefox-profile.mjs:
  // both homes are protected and only marked direct temporary children pass.
  // Do not launch a second process just to re-check this test-only path.
  return canonical;
}

export function bootstrapQaProfile({ loaderSource = DEFAULT_LOADER_SOURCE, deskRecovery = null } = {}) {
  const recovery = deskRecovery ? deskRecoveryFixture(deskRecovery) : null;
  if (typeof loaderSource !== 'string' || !path.isAbsolute(loaderSource)) {
    refuse('loader source must be an absolute directory');
  }
  const source = fs.realpathSync.native(loaderSource);
  const sourceInfo = fs.lstatSync(source);
  if (!sourceInfo.isDirectory() || sourceInfo.isSymbolicLink()) refuse('loader source must be a real directory');
  const sourceEntries = fs.readdirSync(source).sort();
  if (sourceEntries.join('\n') !== [...LOADER_FILES].sort().join('\n')) {
    refuse('loader source must contain exactly the allowlisted loader utilities');
  }
  for (const filename of LOADER_FILES) {
    const item = path.join(source, filename);
    const info = fs.lstatSync(item);
    if (!info.isFile() || info.isSymbolicLink() || fs.realpathSync.native(item) !== item) {
      refuse(`loader utility is not a regular canonical file: ${filename}`);
    }
  }

  // mkdtemp can return a /var path on macOS while its canonical path begins
  // /private/var. Resolve before the guard or launcher sees this path.
  const profile = createPrivateQaTempDirectory(QA_PROFILE_PREFIX);
  try {
    fs.chmodSync(profile, 0o700);
    fs.writeFileSync(path.join(profile, QA_MARKER_NAME), QA_MARKER_BYTES, { flag: 'wx', mode: 0o600 });
    const chrome = path.join(profile, 'chrome');
    const utilities = path.join(chrome, 'utils');
    fs.mkdirSync(chrome, { mode: 0o700 });
    fs.mkdirSync(utilities, { mode: 0o700 });
    for (const filename of LOADER_FILES) {
      const destination = path.join(utilities, filename);
      fs.copyFileSync(path.join(source, filename), destination, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(destination, 0o600);
    }
    const fixtureRoot = path.join(profile, QA_FIXTURE_DIRECTORY);
    fs.mkdirSync(fixtureRoot, { mode: 0o700 });
    const fixtureArtifact = path.join(fixtureRoot, QA_FIXTURE_FILE);
    fs.writeFileSync(fixtureArtifact, 'EG-Desk deterministic QA fixture reference only.\n',
      { flag: 'wx', mode: 0o600 });
    const realTurnCwd = path.join(fixtureRoot, QA_REAL_TURN_DIRECTORY);
    fs.mkdirSync(realTurnCwd, { mode: 0o700 });
    const backendDataDir = path.join(fixtureRoot, QA_BACKEND_DATA_DIRECTORY);
    fs.mkdirSync(backendDataDir, { mode: 0o700 });
    fs.writeFileSync(path.join(fixtureRoot, QA_FIXTURE_MANIFEST),
      `${JSON.stringify({ kind: 'egdesk-chat-qa-fixture-v1', profile,
        artifactPath: fixtureArtifact, realTurnCwd, backendDataDir, ...(recovery ? { deskRecovery: recovery } : {}) })}\n`, { flag: 'wx', mode: 0o600 });
    if (recovery) {
      // Seed once in this newly created profile. Using prefs.js lets an explicit
      // recovery decision persist normally on later startups; user.js would
      // reapply the bad fixture every time Firefox starts.
      fs.writeFileSync(path.join(profile, 'prefs.js'),
        `// Explicit EG-Desk QA recovery fixture\nuser_pref(${JSON.stringify(recovery.prefName)}, ${JSON.stringify(recovery.raw)});\n`,
        { flag: 'wx', mode: 0o600 });
    }
    assertQaProfile(profile);
    assertQaFixtureManifest(profile);
    return { profile, loaderFiles: [...LOADER_FILES], fixtureArtifact, realTurnCwd, backendDataDir, ...(recovery ? { deskRecovery: recovery.kind } : {}) };
  } catch (error) {
    // Preserve the exact temporary directory for inspection rather than
    // recursively deleting a path after a partial safety failure.
    throw new Error(`${error.message}; incomplete temp profile: ${profile}`);
  }
}

export function assertQaFixtureManifest(profilePath) {
  const profile = assertQaProfile(profilePath);
  const root = path.join(profile, QA_FIXTURE_DIRECTORY);
  const rootInfo = fs.lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !isOwnedAndPrivate(root, rootInfo) ||
      fs.realpathSync.native(root) !== root) {
    refuse('fixture root must be a canonical user-owned directory inside the QA profile');
  }
  const manifestPath = path.join(root, QA_FIXTURE_MANIFEST);
  const artifactPath = path.join(root, QA_FIXTURE_FILE);
  for (const file of [manifestPath, artifactPath]) {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || !isOwnedAndPrivate(file, info) ||
        fs.realpathSync.native(file) !== file) {
      refuse('fixture manifest and artifact must be canonical user-owned regular files');
    }
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.kind !== 'egdesk-chat-qa-fixture-v1' || manifest.profile !== profile ||
      manifest.artifactPath !== artifactPath) {
    refuse('fixture manifest is not bound to this QA profile and artifact');
  }
  if (manifest.deskRecovery && JSON.stringify(manifest.deskRecovery) !==
      JSON.stringify(deskRecoveryFixture(manifest.deskRecovery.kind))) {
    refuse('Desk recovery fixture is not the known bootstrap fixture');
  }
  let realTurnCwd = null;
  if (manifest.realTurnCwd) {
    realTurnCwd = path.join(root, QA_REAL_TURN_DIRECTORY);
    const info = fs.lstatSync(realTurnCwd);
    if (manifest.realTurnCwd !== realTurnCwd || !info.isDirectory() || info.isSymbolicLink() ||
        !isOwnedAndPrivate(realTurnCwd, info) || fs.realpathSync.native(realTurnCwd) !== realTurnCwd) {
      refuse('real-turn cwd must be bound to the manifest fixture root');
    }
  }
  let backendDataDir = null;
  if (manifest.backendDataDir) {
    backendDataDir = path.join(root, QA_BACKEND_DATA_DIRECTORY);
    const info = fs.lstatSync(backendDataDir);
    if (manifest.backendDataDir !== backendDataDir || !info.isDirectory() || info.isSymbolicLink()
        || !isOwnedAndPrivate(backendDataDir, info) || fs.realpathSync.native(backendDataDir) !== backendDataDir) {
      refuse('backend data directory must be bound to the manifest fixture root');
    }
  }
  return { profile, root, manifestPath, artifactPath, realTurnCwd, backendDataDir, deskRecovery: manifest.deskRecovery || null };
}
