import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EGDESK_APP_ROOT, PINNED_NODE_VERSION, pinnedNodeExecutable } from '../helper/egdesk-node-runtime.mjs';
import { nodeDistribution, sha256File, installPinnedNode, verifyPinnedNode } from './install-egdesk-node.mjs';

test('distribution names and checksums cover supported platforms and reject others', () => {
  assert.equal(PINNED_NODE_VERSION, '24.22.1');
  for (const platform of ['darwin', 'linux', 'win32']) for (const arch of ['arm64', 'x64']) {
    const artifact = nodeDistribution({ platform, arch });
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
    assert.ok(artifact.url.startsWith(`https://nodejs.org/dist/v${PINNED_NODE_VERSION}/`));
    assert.ok(artifact.filename.endsWith(platform === 'win32' ? '.zip' : '.tar.gz'));
    assert.ok(pinnedNodeExecutable({ appRoot: '/project', platform, arch }).includes(artifact.name));
  }
  assert.throws(() => nodeDistribution({ platform: 'freebsd', arch: 'x64' }), /No pinned/);
  assert.throws(() => nodeDistribution({ platform: 'linux', arch: 'ia32' }), /No pinned/);
});

test('download checksum mismatch never extracts or overwrites a runtime', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-node-checksum-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sentinel = path.join(root, 'keep.txt');
  fs.writeFileSync(sentinel, 'preserve');
  await assert.rejects(installPinnedNode({ appRoot: root, download: async (_url, target) => {
    fs.writeFileSync(target, 'not the official Node archive');
  } }), /checksum mismatch/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
  assert.deepEqual(fs.readdirSync(path.join(root, '.tmp', 'node-runtime')), []);
});

test('existing invalid runtime is refused without replacement', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-node-existing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = pinnedNodeExecutable({ appRoot: root });
  const destination = process.platform === 'win32' ? path.dirname(executable) : path.dirname(path.dirname(executable));
  fs.mkdirSync(destination, { recursive: true });
  const sentinel = path.join(destination, 'keep.txt');
  fs.writeFileSync(sentinel, 'preserve');
  await assert.rejects(installPinnedNode({ appRoot: root }), /could not be verified/);
  assert.equal(fs.readFileSync(sentinel, 'utf8'), 'preserve');
});

test('project runtime reuse checks the actual Node and SQLite version', {
  skip: !fs.existsSync(pinnedNodeExecutable({ appRoot: EGDESK_APP_ROOT })),
}, async () => {
  const result = await installPinnedNode();
  assert.equal(result.status, 'already-present');
  assert.equal(result.archiveSha256, null);
  assert.equal(result.runtime.nodeVersion, PINNED_NODE_VERSION);
  assert.equal(result.runtime.supported, true);
  assert.deepEqual(verifyPinnedNode(result.executable), result.runtime);
});

test('file digest is SHA-256', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-node-hash-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'data');
  fs.writeFileSync(file, 'abc');
  assert.equal(await sha256File(file), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('official download, checksum, extraction, and installation work together', {
  skip: process.env.EGDESK_RUNTIME_INSTALL_NETWORK_TEST !== '1', timeout: 180000,
}, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'egdesk-node-install-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await installPinnedNode({ appRoot: root });
  assert.equal(result.status, 'installed');
  assert.equal(result.archiveSha256, nodeDistribution().sha256);
  assert.equal(result.runtime.nodeVersion, PINNED_NODE_VERSION);
  assert.equal(result.runtime.supported, true);
  assert.equal(verifyPinnedNode(result.executable).sqliteVersion, result.runtime.sqliteVersion);
});
