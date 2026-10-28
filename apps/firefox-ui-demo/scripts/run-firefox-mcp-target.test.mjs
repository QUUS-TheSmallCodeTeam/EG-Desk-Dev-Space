import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateQaTempDirectory } from './egdesk-qa-platform.mjs';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';
import { prepareQaFirefox, qaFirefoxPreferences, qaAutomationPorts } from './run-firefox-mcp-target.mjs';
import { validateQaFixtureIsolation, QA_ISOLATION_MANIFEST } from './egdesk-qa-fixture-isolation.mjs';

function remove(root, prefix) {
  assert.equal(path.dirname(root), canonicalTempRoot());
  assert.ok(path.basename(root).startsWith(prefix));
  assert.equal(fs.realpathSync.native(root), root);
  fs.rmSync(root, { recursive: true });
}

test('portable QA launcher preserves unrelated preferences and rejects linked destinations', t => {
  const source = createPrivateQaTempDirectory('egdesk-loader-launcher-');
  t.after(() => remove(source, 'egdesk-loader-launcher-'));
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(source, name), `public fixture: ${name}`);
  const { profile } = bootstrapQaProfile({ loaderSource: source });
  t.after(() => remove(profile, 'egdesk-chat-test-'));
  const outside = createPrivateQaTempDirectory('egdesk-launcher-outside-');
  t.after(() => remove(outside, 'egdesk-launcher-outside-'));
  fs.writeFileSync(path.join(outside, 'sentinel'), 'unchanged');
  const chrome = path.join(profile, 'chrome'), parked = path.join(profile, 'chrome-parked');
  fs.renameSync(chrome, parked);
  fs.symlinkSync(outside, chrome, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareQaFirefox(profile), /Linked QA destination/);
  assert.deepEqual(fs.readdirSync(outside), ['sentinel']);
  fs.unlinkSync(chrome);
  fs.renameSync(parked, chrome);
  const target = path.join(profile, 'user.js');
  fs.writeFileSync(target, 'user_pref("example.unrelated", 42);\nuser_pref("marionette.enabled", true);\n');
  prepareQaFirefox(profile, { mode: 'normal' });
  assert.match(fs.readFileSync(target, 'utf8'), /example.unrelated/);
  assert.match(fs.readFileSync(target, 'utf8'), /user_pref\("marionette.enabled", false\)/);
  assert.match(fs.readFileSync(path.join(chrome, 'userChrome.css'), 'utf8'), /eg-desk-surface/);
  const resource = path.join(chrome, 'resources', 'qa-linked');
  fs.symlinkSync(outside, resource, process.platform === 'win32' ? 'junction' : 'dir');
  // A nested link matching a shipped filename is rejected before copying.
  const shipped = path.join(chrome, 'resources', 'EGDeskSurfaceState.sys.mjs');
  fs.unlinkSync(shipped);
  fs.symlinkSync(outside, shipped, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => prepareQaFirefox(profile), /Linked QA destination/);
  assert.equal(fs.readFileSync(path.join(outside, 'sentinel'), 'utf8'), 'unchanged');
});

test('normal mode disables automation and port selection cannot alias the QA channels', () => {
  const normal = qaFirefoxPreferences({ mode: 'normal' });
  assert.equal(normal.get('marionette.enabled'), false);
  assert.equal(normal.get('devtools.debugger.remote-enabled'), false);
  assert.equal(normal.get('termsofuse.bypassNotification'), false);
  assert.equal(qaFirefoxPreferences().has('termsofuse.acceptedVersion'), false);
  assert.equal(qaFirefoxPreferences().has('termsofuse.acceptedDate'), false);
  assert.equal(qaFirefoxPreferences().get('marionette.enabled'), true);
  assert.throws(() => qaAutomationPorts(2828, 2828), /distinct/);
  assert.throws(() => qaAutomationPorts(2830, 6000), /2828/);
  assert.throws(() => qaAutomationPorts(2828, '6000;exit'), /valid/);
});

test('explicit 28831, 28832 and 28833 QA targets stay allowlisted and cannot alias remote channels', () => {
  assert.deepEqual(qaAutomationPorts(28831, 60831), { marionette: 28831, remote: 60831 });
  assert.deepEqual(qaAutomationPorts('28831', '60831'), { marionette: 28831, remote: 60831 });
  assert.deepEqual(qaAutomationPorts(28832, 60832), { marionette: 28832, remote: 60832 });
  assert.deepEqual(qaAutomationPorts('28832', '60832'), { marionette: 28832, remote: 60832 });
  assert.throws(() => qaAutomationPorts(28832, 28832), /distinct/);
  assert.throws(() => qaAutomationPorts(28831, 28831), /distinct/);
  assert.deepEqual(qaAutomationPorts(28833, 60833), { marionette: 28833, remote: 60833 });
  assert.deepEqual(qaAutomationPorts('28833', '60833'), { marionette: 28833, remote: 60833 });
  assert.equal(qaFirefoxPreferences({ marionette: 28833, remote: 60833 }).get('marionette.port'), 28833);
  assert.throws(() => qaAutomationPorts(28833, 28833), /distinct/);
  assert.throws(() => qaAutomationPorts(28834, 60834), /2828/);
  assert.throws(() => qaAutomationPorts(28832, '60832;exit'), /valid/);
});

test('28831, 28832 and 28833 fixture preparation refuses port collisions before any profile writes', t => {
  const source = createPrivateQaTempDirectory('egdesk-loader-launcher-');
  t.after(() => remove(source, 'egdesk-loader-launcher-'));
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(source, name), `public fixture: ${name}`);
  const { profile } = bootstrapQaProfile({ loaderSource: source });
  t.after(() => remove(profile, 'egdesk-chat-test-'));
  const env = { EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_FIXTURE_PORT: '48832' };
  for (const [marionette, remote, fixturePort] of [[28831, 60831, '28831'], [28831, 60831, '60831'],
    [28832, 60832, '28832'], [28832, 60832, '60832'],
    [28833, 60833, '28833'], [28833, 60833, '60833']]) {
    assert.throws(() => prepareQaFirefox(profile, { env: { ...env, EGDESK_QA_FIXTURE_PORT: fixturePort },
      marionette, remote }), /distinct/);
    assert.equal(fs.existsSync(path.join(profile, 'user.js')), false);
    assert.equal(fs.existsSync(path.join(profile, QA_ISOLATION_MANIFEST)), false);
  }
  prepareQaFirefox(profile, { env, marionette: 28832, remote: 60832 });
  const prefs = fs.readFileSync(path.join(profile, 'user.js'), 'utf8');
  assert.match(prefs, /user_pref\("marionette.port", 28832\)/);
  assert.match(prefs, /user_pref\("devtools.debugger.remote-port", 60832\)/);
  assert.equal(validateQaFixtureIsolation(profile, { env }).port, 48832);
});

test('fixture preparation fails before writes for bad ports, and normal QA remains the original overlay', t => {
  const source = createPrivateQaTempDirectory('egdesk-loader-launcher-');
  t.after(() => remove(source, 'egdesk-loader-launcher-'));
  for (const name of LOADER_FILES) fs.writeFileSync(path.join(source, name), `public fixture: ${name}`);
  const { profile } = bootstrapQaProfile({ loaderSource: source });
  t.after(() => remove(profile, 'egdesk-chat-test-'));
  const env = { EGDESK_QA_FIXTURE_TRANSPORT: '1', EGDESK_QA_FIXTURE_PORT: '39220' };
  for (const port of [undefined, '39218', '2829', '6001']) {
    assert.throws(() => prepareQaFirefox(profile, { marionette: 2829, remote: 6001,
      env: { ...env, EGDESK_QA_FIXTURE_PORT: port } }), /FIXTURE_PORT|distinct/);
    assert.equal(fs.existsSync(path.join(profile, 'user.js')), false);
    assert.equal(fs.existsSync(path.join(profile, QA_ISOLATION_MANIFEST)), false);
  }
  prepareQaFirefox(profile, { env: {}, marionette: 2829, remote: 6001 });
  const file = path.join(profile, 'chrome', 'JS/eg-desk-surface.uc.js');
  const original = fs.readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url));
  assert.deepEqual(fs.readFileSync(file), original);
  assert.equal(fs.existsSync(path.join(profile, QA_ISOLATION_MANIFEST)), false);
  prepareQaFirefox(profile, { env, marionette: 2829, remote: 6001 });
  assert.equal(validateQaFixtureIsolation(profile, { env }).port, 39220);
  assert.notDeepEqual(fs.readFileSync(file), original);
  assert.deepEqual(fs.readFileSync(new URL('../overlay/JS/eg-desk-surface.uc.js', import.meta.url)), original);
});
