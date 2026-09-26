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
