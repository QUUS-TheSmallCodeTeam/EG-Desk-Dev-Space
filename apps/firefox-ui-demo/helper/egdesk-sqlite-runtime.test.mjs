import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { inspectSqliteRuntime, assertPatchedSqliteRuntime, isPatchedSqliteVersion } from './egdesk-sqlite-runtime.mjs';

test('WAL-reset guard accepts fixed releases and only the two backported branches', () => {
  for (const version of ['3.51.3', '3.51.4', '3.52.0', '3.53.4', '3.50.7', '3.50.8', '3.44.6', '3.44.7']) {
    assert.equal(isPatchedSqliteVersion(version), true, version);
  }
  for (const version of ['3.51.2', '3.50.4', '3.50.6', '3.49.99', '3.45.9', '3.44.5', '3.7.0',
    '4.0.0', '3.51.3-preview', '', null, undefined, '999999999999999999.52.0']) {
    assert.equal(isPatchedSqliteVersion(version), false, String(version));
  }
});

test('runtime probe measures the executing SQLite using an in-memory database', () => {
  const database = new DatabaseSync(':memory:');
  const actualVersion = database.prepare('SELECT sqlite_version() AS version').get().version;
  database.close();
  const runtime = inspectSqliteRuntime();
  assert.equal(runtime.nodeVersion, process.versions.node);
  assert.equal(runtime.sqliteVersion, actualVersion);
  assert.equal(runtime.patched, isPatchedSqliteVersion(actualVersion));
  assert.equal(runtime.supported, Number(process.versions.node.split('.')[0]) >= 24 && runtime.patched);
  if (runtime.supported) assert.deepEqual(assertPatchedSqliteRuntime(), runtime);
  else assert.throws(() => assertPatchedSqliteRuntime(), error =>
    error.code === 'EGDESK_SQLITE_RUNTIME_UNSAFE' && error.message.includes(actualVersion));
});

test('a disabled SQLite builtin fails closed', () => {
  const script = `const { inspectSqliteRuntime, assertPatchedSqliteRuntime } = await import(process.argv[1]);
    const runtime = inspectSqliteRuntime();
    if (runtime.supported || !runtime.error) throw new Error('missing SQLite was accepted');
    try { assertPatchedSqliteRuntime(); throw new Error('guard was bypassed'); }
    catch (error) { if (error.code !== 'EGDESK_SQLITE_RUNTIME_UNSAFE') throw error; }`;
  const result = spawnSync(process.execPath, ['--no-experimental-sqlite', '--input-type=module', '-e', script,
    new URL('./egdesk-sqlite-runtime.mjs', import.meta.url).href], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('injected Node metadata cannot bypass the actual SQLite guard in file mounts', {
  skip: !process.env.EGDESK_TEST_UNPATCHED_NODE,
}, () => {
  const script = `const { createEGDeskFileMount } = await import(process.argv[1]);
    let adapterCreated = false;
    try {
      createEGDeskFileMount({ dataDir: '/unused', nodeRuntime: { version: '24.22.1', hasSqlite: true },
        createNativeAdapter: () => { adapterCreated = true; }, createHttpAdapter: () => { adapterCreated = true; } });
      throw new Error('vulnerable SQLite was accepted');
    } catch (error) { if (error.code !== 'EGDESK_SQLITE_RUNTIME_UNSAFE' || adapterCreated) throw error; }`;
  const result = spawnSync(process.env.EGDESK_TEST_UNPATCHED_NODE,
    ['--input-type=module', '-e', script, new URL('./egdesk-file-mount.mjs', import.meta.url).href], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
