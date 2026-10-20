import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPrivateQaTempDirectory, isOwnedAndPrivate, isSafeWindowsAcl } from './egdesk-qa-platform.mjs';

test('Windows ownership rejects other writers and checks every inherited ACE', () => {
  const self = 'S-1-5-21-123-456-789-1002';
  const acl = { self, owner: self, rules: [{ sid: self, rights: 0x1f01ff, allow: true },
    { sid: 'S-1-5-18', rights: 0x1f01ff, allow: true }] };
  assert.equal(isSafeWindowsAcl(acl), true);
  assert.equal(isSafeWindowsAcl({ ...acl, owner: 'S-1-5-18' }), false);
  for (const rights of [2, 4, 16, 64, 256, 65536, 262144, 524288, 0x1f01ff]) {
    assert.equal(isSafeWindowsAcl({ ...acl, rules: [...acl.rules,
      { sid: 'S-1-1-0', rights, allow: true }] }), false, `other principal has rights ${rights}`);
  }
  const readable = { ...acl, rules: [...acl.rules, { sid: 'S-1-1-0', rights: 1, allow: true }] };
  assert.equal(isSafeWindowsAcl(readable), true);
  assert.equal(isSafeWindowsAcl(readable, 0o077), false);
  assert.equal(isSafeWindowsAcl({ ...acl, rules: [] }), false);
});

test('a newly created QA directory is private; real permission tampering is rejected', t => {
  const root = createPrivateQaTempDirectory('egdesk-platform-test-');
  t.after(() => {
    assert.match(path.basename(root), /^egdesk-platform-test-/);
    assert.equal(fs.realpathSync.native(root), root);
    fs.rmSync(root, { recursive: true });
  });
  const marker = path.join(root, 'marker');
  fs.writeFileSync(marker, 'public QA marker', { flag: 'wx', mode: 0o600 });
  assert.equal(isOwnedAndPrivate(root), true);
  assert.equal(isOwnedAndPrivate(marker), true);
  if (process.platform === 'win32') {
    execFileSync('icacls.exe', [marker, '/grant', '*S-1-5-32-545:(W)'], { windowsHide: true, stdio: 'pipe' });
  } else fs.chmodSync(marker, 0o622);
  assert.equal(isOwnedAndPrivate(marker), false);
});
