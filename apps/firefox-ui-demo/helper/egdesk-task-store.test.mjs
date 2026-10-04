import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openTaskStore } from './egdesk-task-store.mjs';

test('atomic journal round trip and concurrent writer conflict', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'egdesk-task-store-'));
  try {
    const first = await openTaskStore(directory);
    const second = await openTaskStore(directory);
    assert.deepEqual(await first.load(), []);
    assert.deepEqual(await second.load(), []);
    const events = [{ seq: 1, at: '2026-09-27T00:00:00.000Z', type: 'example' }];
    await first.save(events);
    assert.deepEqual(await (await openTaskStore(directory)).load(), events);
    await assert.rejects(second.save(events), { code: 'E_TASK_STORE_CONFLICT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('corruption is reported and original bytes remain untouched', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'egdesk-task-store-'));
  try {
    const filename = path.join(directory, 'task-events.json');
    const original = '{broken journal';
    await writeFile(filename, original);
    const store = await openTaskStore(directory);
    await assert.rejects(store.load(), { code: 'E_TASK_STORE_CORRUPT' });
    assert.equal(await readFile(filename, 'utf8'), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
