import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createPrivateQaTempDirectory } from './egdesk-qa-platform.mjs';
import { bootstrapQaProfile, canonicalTempRoot, LOADER_FILES } from './egdesk-chat-qa-profile.mjs';
import { prepareQaFirefox, qaFirefoxPreferences, qaAutomationPorts } from './run-firefox-mcp-target.mjs';

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
