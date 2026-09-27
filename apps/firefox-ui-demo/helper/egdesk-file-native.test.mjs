import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEGDeskNativeCreateOnlyAdapter } from './egdesk-file-native.mjs';

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'egdesk-native-create-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function fakeExecutable(t, source) {
  const directory = await temporaryDirectory(t);
  const executable = path.join(directory, 'fake-native');
  await fs.writeFile(executable, `#!${process.execPath}\n${source}\n`, { mode: 0o700 });
  return executable;
}

const FAKE_RECEIPT = `
const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  const request = Buffer.concat(chunks);
  if (process.argv.length !== 2 || request.subarray(0, 8).toString() !== 'EGDCRQ01') {
    process.exit(9);
  }
  const fieldsLength = request.readUInt32BE(8) + request.readUInt32BE(12) +
    request.readUInt32BE(16) + request.readUInt32BE(20);
  const payload = request.subarray(64 + fieldsLength);
  const receipt = Buffer.alloc(40);
  receipt.write('EGDCRS01', 0, 'ascii');
  receipt.writeUInt32BE(0, 8);
  receipt.writeUInt32BE(1, 12);
  receipt.writeBigUInt64BE(BigInt(payload.length), 16);
  receipt.writeBigUInt64BE(33n, 24);
  receipt.writeBigUInt64BE(44n, 32);
  const readback = Buffer.from(payload);
  if (process.env.EGDESK_FAKE_MUTATE === '1' && readback.length) readback[0] ^= 0xff;
  process.stdout.write(Buffer.concat([receipt, readback]), () => {
    process.exit(process.env.EGDESK_FAKE_BAD_EXIT === '1' ? 1 : 0);
  });
});
`;

function args(rootPath = '/tmp/egdesk-native-test', bytes = Buffer.from([0, 255, 10])) {
  return {
    rootPath,
    rootIdentity: { dev: '1', ino: '2' },
    relativeDirectory: '',
    directoryIdentity: { dev: '1', ino: '2' },
    fileName: 'safe.bin',
    bytes,
    operationId: 'native-test-1',
  };
}

test('adapter frames exact binary stdin and hashes the readback', async (t) => {
  const executable = await fakeExecutable(t, FAKE_RECEIPT);
  const bytes = Buffer.concat([Buffer.from('한글-α', 'utf8'), Buffer.from([0, 255, 10])]);
  const adapter = createEGDeskNativeCreateOnlyAdapter({ executable });
  assert.equal(adapter.capability, 'descriptor-relative-create-only');
  assert.deepEqual(await adapter.createFile(args('/tmp/테스트', bytes)), {
    created: true,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    dev: '33',
    ino: '44',
  });
});

test('adapter rejects malformed readback, receipt, exit, timeout, and missing binary', async (t) => {
  const executable = await fakeExecutable(t, FAKE_RECEIPT.replace(
    "process.env.EGDESK_FAKE_MUTATE === '1' && readback.length", 'readback.length'));
  const adapter = createEGDeskNativeCreateOnlyAdapter({ executable });
  await assert.rejects(adapter.createFile(args()), (error) => {
    assert.equal(error.code, 'EGDESK_NATIVE_READBACK_MISMATCH');
    assert.equal(error.created, true);
    assert.equal(error.fileMayExist, true);
    return true;
  });

  const broken = await fakeExecutable(t, `process.stdin.resume(); process.stdout.write('bad');`);
  await assert.rejects(
    createEGDeskNativeCreateOnlyAdapter({ executable: broken }).createFile(args()),
    { code: 'EGDESK_NATIVE_PROTOCOL', fileMayExist: true },
  );

  const badExit = await fakeExecutable(t, FAKE_RECEIPT.replace(
    "process.env.EGDESK_FAKE_BAD_EXIT === '1' ? 1 : 0", '1'));
  await assert.rejects(
    createEGDeskNativeCreateOnlyAdapter({ executable: badExit }).createFile(args()),
    { code: 'EGDESK_NATIVE_PROTOCOL', fileMayExist: true },
  );

  const badMetadata = await fakeExecutable(t, FAKE_RECEIPT.replace(
    'receipt.writeBigUInt64BE(33n, 24)', 'receipt.writeBigUInt64BE(0n, 24)'));
  await assert.rejects(
    createEGDeskNativeCreateOnlyAdapter({ executable: badMetadata }).createFile(args()),
    { code: 'EGDESK_NATIVE_PROTOCOL', fileMayExist: true },
  );

  const excessiveOutput = await fakeExecutable(t,
    `process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(Buffer.alloc(1024)));`);
  await assert.rejects(
    createEGDeskNativeCreateOnlyAdapter({ executable: excessiveOutput }).createFile(args()),
    { code: 'EGDESK_NATIVE_OUTPUT_LIMIT', fileMayExist: true },
  );

  const hung = await fakeExecutable(t, `process.stdin.resume(); setInterval(() => {}, 1000);`);
  await assert.rejects(
    createEGDeskNativeCreateOnlyAdapter({ executable: hung, timeoutMs: 50 }).createFile(args()),
    { code: 'EGDESK_NATIVE_TIMEOUT', fileMayExist: true },
  );

  await assert.rejects(
    createEGDeskNativeCreateOnlyAdapter({ executable: '/definitely/missing/egdesk-create' })
      .createFile(args()),
    { code: 'EGDESK_NATIVE_UNAVAILABLE', fileMayExist: false },
  );
});

test('adapter reports a partial new file without attempting pathname cleanup', async (t) => {
  const executable = await fakeExecutable(t, `
process.stdin.resume();
process.stdin.on('end', () => {
  const receipt = Buffer.alloc(40);
  receipt.write('EGDCRS01', 0, 'ascii');
  receipt.writeUInt32BE(8, 8); // write failed after O_EXCL creation
  receipt.writeUInt32BE(1, 12);
  receipt.writeBigUInt64BE(33n, 24);
  receipt.writeBigUInt64BE(44n, 32);
  process.stdout.write(receipt, () => process.exit(1));
});`);
  await assert.rejects(
    createEGDeskNativeCreateOnlyAdapter({ executable }).createFile(args()),
    (error) => {
      assert.equal(error.code, 'EGDESK_NATIVE_REFUSED');
      assert.equal(error.nativeStatus, 8);
      assert.equal(error.created, true);
      assert.equal(error.fileMayExist, true);
      assert.match(error.message, /left in place/);
      return true;
    },
  );
});

test('adapter rejects unsafe components and inexact identities before dispatch', () => {
  const adapter = createEGDeskNativeCreateOnlyAdapter();
  assert.throws(() => adapter.createFile({ ...args(), relativeDirectory: '../escape' }),
    /ordinary components/);
  assert.throws(() => adapter.createFile({ ...args(), fileName: 'sub/leaf' }),
    /one ordinary component/);
  assert.throws(() => adapter.createFile({
    ...args(), rootIdentity: { dev: Number.MAX_SAFE_INTEGER + 1, ino: 2 },
  }), /exact unsigned integer/);
  assert.throws(() => adapter.createFile({ ...args(), bytes: Buffer.alloc(16 * 1024 * 1024 + 1) }),
    /byte limit/);
});

const binary = process.env.EGDESK_NATIVE_CREATE_BINARY;
const nativeTest = binary ? test : test.skip;

async function nativeAdapterAndRoot(t) {
  const rootPath = await temporaryDirectory(t);
  const adapter = createEGDeskNativeCreateOnlyAdapter({ executable: binary });
  const rootIdentity = await fs.stat(rootPath, { bigint: true });
  return { rootPath, adapter, rootIdentity };
}

nativeTest('native roundtrip: UTF-8 name, binary bytes, metadata, and 0600', async (t) => {
  const { rootPath, adapter, rootIdentity } = await nativeAdapterAndRoot(t);
  const relativeDirectory = '자료/계약';
  const directory = path.join(rootPath, relativeDirectory);
  await fs.mkdir(directory, { recursive: true });
  const directoryIdentity = await fs.stat(directory, { bigint: true });
  const fileName = '영수증-α.bin';
  const bytes = Buffer.concat([Buffer.from('한글 α', 'utf8'), Buffer.from([0, 255, 10, 0])]);
  const result = await adapter.createFile({
    rootPath, rootIdentity, relativeDirectory, directoryIdentity,
    fileName, bytes, operationId: 'roundtrip-1',
  });
  const actualPath = path.join(directory, fileName);
  const actual = await fs.readFile(actualPath);
  const metadata = await fs.stat(actualPath, { bigint: true });
  assert.deepEqual(actual, bytes);
  assert.equal(result.created, true);
  assert.equal(result.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.size, bytes.length);
  assert.equal(result.dev, metadata.dev.toString());
  assert.equal(result.ino, metadata.ino.toString());
  assert.equal(Number(metadata.mode & 0o777n), 0o600);

  const empty = await adapter.createFile({
    rootPath, rootIdentity, relativeDirectory, directoryIdentity,
    fileName: 'empty.bin', bytes: Buffer.alloc(0), operationId: 'roundtrip-empty',
  });
  assert.equal(empty.size, 0);
  assert.equal(empty.sha256, createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  assert.deepEqual(await fs.readFile(path.join(directory, 'empty.bin')), Buffer.alloc(0));
});

nativeTest('native refuses existing leaf and leaf symlink without changing originals', async (t) => {
  const { rootPath, adapter, rootIdentity } = await nativeAdapterAndRoot(t);
  const outside = await temporaryDirectory(t);
  const original = path.join(rootPath, 'existing.bin');
  const outsideFile = path.join(outside, 'outside.bin');
  await fs.writeFile(original, 'original');
  await fs.writeFile(outsideFile, 'outside');
  const base = {
    rootPath, rootIdentity, relativeDirectory: '', directoryIdentity: rootIdentity,
    bytes: Buffer.from('replacement'), operationId: 'refuse-leaf',
  };
  await assert.rejects(adapter.createFile({ ...base, fileName: 'existing.bin' }),
    { code: 'EGDESK_NATIVE_REFUSED', nativeStatus: 5, created: false });
  assert.equal(await fs.readFile(original, 'utf8'), 'original');

  await fs.symlink(outsideFile, path.join(rootPath, 'escape.bin'));
  await assert.rejects(adapter.createFile({ ...base, fileName: 'escape.bin' }),
    { code: 'EGDESK_NATIVE_REFUSED', nativeStatus: 5, created: false });
  assert.equal(await fs.readFile(outsideFile, 'utf8'), 'outside');
});

nativeTest('native refuses parent swaps and mismatched root/directory identities', async (t) => {
  const { rootPath, adapter, rootIdentity } = await nativeAdapterAndRoot(t);
  const outside = await temporaryDirectory(t);
  const parent = path.join(rootPath, 'parent');
  await fs.mkdir(parent);
  const originalParent = await fs.stat(parent, { bigint: true });
  const base = {
    rootPath, rootIdentity, relativeDirectory: 'parent',
    directoryIdentity: originalParent, fileName: 'new.bin',
    bytes: Buffer.from('safe'), operationId: 'parent-swap',
  };

  await assert.rejects(adapter.createFile({
    ...base, rootIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino + 1n },
  }), { code: 'EGDESK_NATIVE_REFUSED', nativeStatus: 2, created: false });
  await assert.rejects(adapter.createFile({
    ...base, directoryIdentity: { dev: originalParent.dev, ino: originalParent.ino + 1n },
  }), { code: 'EGDESK_NATIVE_REFUSED', nativeStatus: 4, created: false });

  await fs.rename(parent, path.join(rootPath, 'parent-original'));
  await fs.symlink(outside, parent);
  await assert.rejects(adapter.createFile(base),
    { code: 'EGDESK_NATIVE_REFUSED', nativeStatus: 3, created: false });
  await assert.rejects(fs.stat(path.join(outside, 'new.bin')), { code: 'ENOENT' });
  await fs.rm(parent);
  await fs.mkdir(parent);
  await assert.rejects(adapter.createFile(base),
    { code: 'EGDESK_NATIVE_REFUSED', nativeStatus: 4, created: false });
  await assert.rejects(fs.stat(path.join(parent, 'new.bin')), { code: 'ENOENT' });
});

nativeTest('native leaves a newly created file intact after a bounded write failure', async (t) => {
  const { rootPath, rootIdentity } = await nativeAdapterAndRoot(t);
  const wrapperDirectory = await temporaryDirectory(t);
  const limitedExecutable = path.join(wrapperDirectory, 'limited-native');
  await fs.writeFile(limitedExecutable, `#!/bin/sh
ulimit -f 1
trap '' XFSZ
exec "$EGDESK_NATIVE_CREATE_BINARY"
`, { mode: 0o700 });
  const limited = createEGDeskNativeCreateOnlyAdapter({ executable: limitedExecutable });
  const direct = createEGDeskNativeCreateOnlyAdapter({ executable: binary });
  const bytes = Buffer.alloc(4096, 0x5a);
  const request = {
    rootPath, rootIdentity, relativeDirectory: '', directoryIdentity: rootIdentity,
    fileName: 'partial.bin', bytes, operationId: 'partial-write',
  };

  await assert.rejects(limited.createFile(request), (error) => {
    assert.equal(error.fileMayExist, true);
    return true;
  });
  const partialPath = path.join(rootPath, 'partial.bin');
  const partial = await fs.readFile(partialPath);
  assert.ok(partial.length < bytes.length);
  await assert.rejects(direct.createFile(request),
    { code: 'EGDESK_NATIVE_REFUSED', nativeStatus: 5, created: false });
  assert.deepEqual(await fs.readFile(partialPath), partial);
});
