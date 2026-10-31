import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = fileURLToPath(new URL('.', import.meta.url));
const validator = path.join(scripts, 'validate-firefox-profile.mjs');
const writer = path.join(scripts, 'write-userjs.sh');
const launcher = path.join(scripts, 'run-firefox-mcp-target.sh');
const marker = '.egdesk-dedicated-firefox-profile';

function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-profile-guard-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeProfile(root, name = 'alternate-profile') {
  const profile = path.join(root, name);
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  return profile;
}

function mark(profile, content = 'EGDESK_DEDICATED_FIREFOX_PROFILE_V1\n') {
  fs.writeFileSync(path.join(profile, marker), content, { mode: 0o600 });
}

function run(command, args, env = {}) {
  const environment = { ...process.env };
  delete environment.EGDESK_FIREFOX_MARIONETTE_PORT;
  delete environment.EGDESK_FIREFOX_REMOTE_AGENT_PORT;
  return spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...environment, ...env },
  });
}

test('an unmarked alternate is refused even with the default-looking name', t => {
  const profile = makeProfile(fixture(t), 'egtc3irr.egdesk.default-release');
  const result = run(process.execPath, [validator, profile]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsafe Firefox profile|ENOENT/);
});

test('the existing dedicated default validates read-only without a marker', t => {
  const profile = path.join(
    os.userInfo().homedir,
    'Library/Application Support/Firefox/Profiles/egtc3irr.egdesk.default-release',
  );
  if (!fs.existsSync(profile)) {
    t.skip('the existing dedicated Firefox profile is not installed here');
    return;
  }
  const result = run(process.execPath, [validator, profile]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), profile);
});

test('exact marker accepts an isolated alternate; bad or symlinked markers do not', t => {
  const root = fixture(t);
  const profile = makeProfile(root);
  mark(profile);
  const accepted = run(process.execPath, [validator, profile]);
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.equal(accepted.stdout.trim(), profile);

  mark(profile, 'wrong marker\n');
  assert.notEqual(run(process.execPath, [validator, profile]).status, 0);
  fs.unlinkSync(path.join(profile, marker));
  const target = path.join(root, 'marker-target');
  fs.writeFileSync(target, 'EGDESK_DEDICATED_FIREFOX_PROFILE_V1\n');
  fs.symlinkSync(target, path.join(profile, marker));
  assert.notEqual(run(process.execPath, [validator, profile]).status, 0);
});

test('symlinked profile or parent and a HOME target are refused', t => {
  const root = fixture(t);
  const profile = makeProfile(root);
  mark(profile);
  const alias = path.join(root, 'profile-link');
  fs.symlinkSync(profile, alias);
  assert.notEqual(run(process.execPath, [validator, alias]).status, 0);

  const parent = path.join(root, 'parent');
  fs.mkdirSync(parent, { mode: 0o700 });
  const nested = makeProfile(parent, 'nested');
  mark(nested);
  const parentAlias = path.join(root, 'parent-link');
  fs.symlinkSync(parent, parentAlias);
  assert.notEqual(run(process.execPath, [validator, path.join(parentAlias, 'nested')]).status, 0);

  const fakeHome = makeProfile(root, 'home');
  mark(fakeHome);
  assert.notEqual(run(process.execPath, [validator, fakeHome], { HOME: fakeHome }).status, 0);
});

test('direct writer refuses an unmarked profile without touching user.js', t => {
  const profile = makeProfile(fixture(t));
  const original = 'user_pref("browser.startup.homepage", "about:blank");\n';
  fs.writeFileSync(path.join(profile, 'user.js'), original);
  const result = run('/bin/bash', [writer], {
    EGDESK_FIREFOX_PROFILE: profile,
    EGDESK_FIREFOX_MODE: 'automation',
  });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(profile, 'user.js'), 'utf8'), original);
  assert.deepEqual(fs.readdirSync(profile), ['user.js']);
});

test('marked writer keeps unrelated prefs and disables remote access in normal mode', t => {
  const profile = makeProfile(fixture(t));
  mark(profile);
  const userJs = path.join(profile, 'user.js');
  fs.writeFileSync(userJs, [
    '// Keep my setting.',
    'user_pref("browser.startup.homepage", "about:blank");',
    'user_pref("devtools.debugger.remote-enabled", false);',
    'user_pref("marionette.enabled", false);',
    '',
  ].join('\n'));

  const env = { EGDESK_FIREFOX_PROFILE: profile, EGDESK_FIREFOX_MODE: 'automation' };
  const automation = run('/bin/bash', [writer], env);
  assert.equal(automation.status, 0, automation.stderr);
  let content = fs.readFileSync(userJs, 'utf8');
  assert.match(content, /\/\/ Keep my setting\./);
  assert.match(content, /user_pref\("browser.startup.homepage", "about:blank"\);/);
  assert.match(content, /user_pref\("devtools.debugger.remote-enabled", true\);/);
  assert.match(content, /user_pref\("marionette.enabled", true\);/);
  assert.match(content, /user_pref\("marionette.port", 2828\);/);
  assert.match(content, /user_pref\("devtools.debugger.remote-port", 6000\);/);
  assert.equal((content.match(/user_pref\("devtools.debugger.remote-enabled"/g) || []).length, 1);

  const isolatedPorts = run('/bin/bash', [writer], {
    ...env,
    EGDESK_FIREFOX_MARIONETTE_PORT: '2829',
    EGDESK_FIREFOX_REMOTE_AGENT_PORT: '6001',
  });
  assert.equal(isolatedPorts.status, 0, isolatedPorts.stderr);
  content = fs.readFileSync(userJs, 'utf8');
  assert.match(content, /user_pref\("marionette.port", 2829\);/);
  assert.match(content, /user_pref\("devtools.debugger.remote-port", 6001\);/);

  const normal = run('/bin/bash', [writer], { ...env, EGDESK_FIREFOX_MODE: 'normal' });
  assert.equal(normal.status, 0, normal.stderr);
  content = fs.readFileSync(userJs, 'utf8');
  assert.match(content, /user_pref\("devtools.debugger.remote-enabled", false\);/);
  assert.match(content, /user_pref\("marionette.enabled", false\);/);
  assert.match(content, /user_pref\("devtools.debugger.prompt-connection", true\);/);
  assert.match(content, /user_pref\("browser.startup.homepage", "about:blank"\);/);
});

test('writer rejects invalid or colliding ports without changing prefs', t => {
  const profile = makeProfile(fixture(t));
  mark(profile);
  const userJs = path.join(profile, 'user.js');
  fs.writeFileSync(userJs, 'user_pref("browser.startup.homepage", "about:blank");\n');
  const before = fs.readFileSync(userJs, 'utf8');
  const base = { EGDESK_FIREFOX_PROFILE: profile, EGDESK_FIREFOX_MODE: 'automation' };
  for (const ports of [
    { EGDESK_FIREFOX_MARIONETTE_PORT: '0' },
    { EGDESK_FIREFOX_REMOTE_AGENT_PORT: '65536' },
    { EGDESK_FIREFOX_MARIONETTE_PORT: '2829;not-a-port' },
    { EGDESK_FIREFOX_MARIONETTE_PORT: '6000' },
  ]) {
    const result = run('/bin/bash', [writer], { ...base, ...ports });
    assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(userJs, 'utf8'), before);
  }
});

test('launcher refuses an unmarked profile before overlay or cache mutation', t => {
  const root = fixture(t);
  const profile = makeProfile(root);
  const cache = path.join(profile, 'startupCache');
  fs.mkdirSync(cache);
  fs.writeFileSync(path.join(cache, 'keep'), 'keep');
  const fakeFirefox = path.join(root, 'fake-firefox');
  fs.writeFileSync(fakeFirefox, '#!/bin/sh\nexit 99\n', { mode: 0o700 });

  const result = run('/bin/bash', [launcher, '--automation'], {
    EGDESK_FIREFOX_BIN: fakeFirefox,
    EGDESK_FIREFOX_PROFILE: profile,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsafe Firefox profile|ENOENT/);
  assert.equal(fs.readFileSync(path.join(cache, 'keep'), 'utf8'), 'keep');
  assert.deepEqual(fs.readdirSync(profile), ['startupCache']);
});

test('launcher rejects invalid ports before any profile mutation', t => {
  const root = fixture(t);
  const profile = makeProfile(root);
  mark(profile);
  const fakeFirefox = path.join(root, 'fake-firefox');
  fs.writeFileSync(fakeFirefox, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const result = run('/bin/bash', [launcher, '--automation'], {
    EGDESK_FIREFOX_BIN: fakeFirefox,
    EGDESK_FIREFOX_PROFILE: profile,
    EGDESK_FIREFOX_MARIONETTE_PORT: '0',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EGDESK_FIREFOX_MARIONETTE_PORT/);
  assert.deepEqual(fs.readdirSync(profile), [marker]);
});

// Runs the whole launcher against temporary folders only. A `node` shim on
// PATH answers the two bridge questions, so the running :39218 bridge is never
// contacted and no bridge is started, and hands every other launcher step
// (profile guard, user.js writer, build hash) to this Node. Any other node
// call fails the run. The fake Firefox only records its arguments.
function launchWithFakeBridge(root, env) {
  const quote = value => `'${value.replaceAll("'", `'\\''`)}'`;
  const bin = path.join(root, 'fake-bin');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(bin, 'node'), [
    '#!/bin/sh',
    'case "$1" in',
    '  */helper/egdesk-ontology-http.mjs)',
    '    case "$2" in',
    '      --check-existing-bridge) echo compatible; exit 0 ;;',
    '      --prepare-profile) exit 0 ;;',
    '    esac ;;',
    `  */scripts/validate-firefox-profile.mjs|*/helper/egdesk-bridge-build.mjs|-) exec ${quote(process.execPath)} "$@" ;;`,
    'esac',
    'echo "unexpected node call: $*" >&2',
    'exit 97',
    '',
  ].join('\n'), { mode: 0o700 });
  const argsFile = path.join(root, 'firefox-args');
  fs.rmSync(argsFile, { force: true });
  const firefox = path.join(root, 'fake-firefox');
  fs.writeFileSync(firefox, `#!/bin/sh\nprintf '%s\\n' "$@" > ${quote(argsFile)}\n`, { mode: 0o700 });
  const result = run('/bin/bash', [launcher, '--normal', 'about:blank'], {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    EGDESK_FIREFOX_BIN: firefox,
    ...env,
  });
  const args = fs.existsSync(argsFile) ? fs.readFileSync(argsFile, 'utf8').split('\n') : [];
  return { result, args };
}

function cacheHome(root) {
  const home = path.join(root, 'home');
  return {
    home,
    profiles: path.join(home, 'Library/Application Support/Firefox/Profiles'),
    local: path.join(home, 'Library/Caches/Firefox/Profiles'),
  };
}

function seed(folder, file = 'scriptCache.bin', content = 'old compiled modules') {
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(folder, file), content);
  return path.join(folder, file);
}

test('launcher clears the local startup cache of a profile in the Firefox profiles folder, and nothing beside it', t => {
  const root = fixture(t);
  const { home, profiles, local } = cacheHome(root);
  const leaf = 'qa1234.egdesk-cache-test';
  const profile = makeProfile(profiles, leaf);
  mark(profile);
  seed(path.join(profile, 'startupCache'));
  const localProfile = path.join(local, leaf);
  seed(path.join(localProfile, 'startupCache'));
  const keptCache2 = seed(path.join(localProfile, 'cache2'), 'keep', 'network cache');
  const keptFile = seed(localProfile, 'keep.txt', 'keep');
  const otherProfile = seed(path.join(local, 'other.default-release', 'startupCache'), 'scriptCache.bin', 'other profile');

  const { result, args } = launchWithFakeBridge(root, { HOME: home, EGDESK_FIREFOX_PROFILE: profile });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(args.slice(0, 4), ['-profile', profile, '--no-remote', 'about:blank']);
  assert.equal(fs.existsSync(path.join(localProfile, 'startupCache')), false);
  assert.equal(fs.existsSync(path.join(profile, 'startupCache')), false);
  assert.deepEqual(fs.readdirSync(localProfile).sort(), ['cache2', 'keep.txt']);
  assert.equal(fs.readFileSync(keptCache2, 'utf8'), 'network cache');
  assert.equal(fs.readFileSync(keptFile, 'utf8'), 'keep');
  assert.equal(fs.readFileSync(otherProfile, 'utf8'), 'other profile');
  assert.doesNotMatch(result.stderr, /local startup cache left in place/);
});

test('launcher leaves local caches alone for a profile outside the Firefox profiles folder or with an unsafe leaf', t => {
  const root = fixture(t);
  const { home, profiles, local } = cacheHome(root);
  const cases = [
    // A QA profile given by path keeps its cache inside the profile.
    { profile: makeProfile(root, 'qa-profile'), kept: [path.join(local, 'qa-profile', 'startupCache')] },
    // A nested folder is not a <leaf> directly under Profiles/.
    { profile: makeProfile(profiles, 'group/nested'), kept: [
      path.join(local, 'group', 'nested', 'startupCache'), path.join(local, 'group', 'startupCache')] },
    // A leaf containing '..' is never turned into a cache path.
    { profile: makeProfile(profiles, 'a..b'), kept: [path.join(local, 'a..b', 'startupCache')] },
  ];
  for (const { profile, kept } of cases) {
    mark(profile);
    seed(path.join(profile, 'startupCache'));
    const files = kept.map(folder => seed(folder));
    const { result, args } = launchWithFakeBridge(root, { HOME: home, EGDESK_FIREFOX_PROFILE: profile });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(args[1], profile);
    assert.equal(fs.existsSync(path.join(profile, 'startupCache')), false, `${profile} own cache is cleared`);
    for (const file of files) assert.equal(fs.readFileSync(file, 'utf8'), 'old compiled modules', `${file} is kept`);
  }
});

test('launcher does not follow a linked local profile folder and leaves a refused profile\'s local cache alone', t => {
  const root = fixture(t);
  const { home, profiles, local } = cacheHome(root);
  const leaf = 'qa5678.egdesk-cache-test';
  const profile = makeProfile(profiles, leaf);
  mark(profile);
  fs.mkdirSync(local, { recursive: true, mode: 0o700 });
  const elsewhere = path.join(root, 'elsewhere');
  const target = seed(path.join(elsewhere, 'startupCache'));
  fs.symlinkSync(elsewhere, path.join(local, leaf));
  let { result } = launchWithFakeBridge(root, { HOME: home, EGDESK_FIREFOX_PROFILE: profile });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /local startup cache left in place/);
  assert.equal(fs.readFileSync(target, 'utf8'), 'old compiled modules');

  // A linked parent (…/Caches/Firefox/Profiles → elsewhere) is refused the same way.
  fs.unlinkSync(path.join(local, leaf));
  fs.renameSync(local, path.join(root, 'local-parked'));
  const linkedParent = path.join(root, 'linked-parent');
  const parentTarget = seed(path.join(linkedParent, leaf, 'startupCache'));
  fs.symlinkSync(linkedParent, local);
  ({ result } = launchWithFakeBridge(root, { HOME: home, EGDESK_FIREFOX_PROFILE: profile }));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /local startup cache left in place/);
  assert.equal(fs.readFileSync(parentTarget, 'utf8'), 'old compiled modules');

  // An unmarked profile is refused before either cache is touched.
  fs.unlinkSync(local);
  const unmarked = makeProfile(profiles, 'unmarked.egdesk-cache-test');
  const ownCache = seed(path.join(unmarked, 'startupCache'));
  const localCache = seed(path.join(local, 'unmarked.egdesk-cache-test', 'startupCache'));
  ({ result } = launchWithFakeBridge(root, { HOME: home, EGDESK_FIREFOX_PROFILE: unmarked }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsafe Firefox profile|ENOENT/);
  assert.equal(fs.readFileSync(ownCache, 'utf8'), 'old compiled modules');
  assert.equal(fs.readFileSync(localCache, 'utf8'), 'old compiled modules');
});
