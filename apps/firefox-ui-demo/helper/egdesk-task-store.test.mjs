import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openTaskGraph } from './egdesk-task-graph.mjs';
import { openTaskStore } from './egdesk-task-store.mjs';
import { openWorkflowStore } from './egdesk-workflow-store.mjs';

// Stores are closed before the folder goes, so no write races the removal.
async function folder(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'egdesk-task-store-'));
  const opened = [];
  t.after(async () => {
    for (const store of opened) store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, open: async (target = directory) => { const store = await openTaskStore(target); opened.push(store); return store; } };
}
const at = '2026-09-27T00:00:00.000Z';
const legacyFile = (events) => JSON.stringify({ version: 1, digest: createHash('sha256').update(JSON.stringify(events)).digest('hex'), events });

test('journal round trip and concurrent writer conflict', async (t) => {
  const f = await folder(t);
  const first = await f.open();
  const second = await f.open();
  assert.deepEqual(await first.load(), []);
  assert.deepEqual(await second.load(), []);
  const events = [{ seq: 1, at, type: 'example' }];
  await first.save(events);
  assert.deepEqual(await (await f.open()).load(), events);
  await assert.rejects(second.save(events), { code: 'E_TASK_STORE_CONFLICT' });
  assert.deepEqual(await readdir(f.directory).then((names) => names.filter((name) => name.endsWith('.json'))), [], 'no JSON journal is written');
  assert.equal((await stat(path.join(f.directory, 'workflow.sqlite'))).mode & 0o777, 0o600);
});

test('save appends only the new tail; saved history cannot be rewritten or shortened', async (t) => {
  const f = await folder(t);
  const store = await f.open();
  await store.load();
  const events = [{ seq: 1, at, type: 'a' }, { seq: 2, at, type: 'b' }];
  await store.save(events);
  await store.save(events); // nothing new: no write
  await store.save([...events, { seq: 3, at, type: 'c' }]);
  await assert.rejects(store.save([{ seq: 1, at, type: 'a' }]), { code: 'E_TASK_STORE_CONFLICT' });
  await assert.rejects(store.save([{ seq: 1, at, type: 'a' }, { seq: 2, at, type: 'b' }, { seq: 3, at, type: 'changed' }, { seq: 4, at, type: 'd' }]),
    { code: 'E_TASK_STORE_CONFLICT' });
  await assert.rejects(store.save([...events, { seq: 3, at, type: 'c' }, { seq: 9, at, type: 'gap' }]), TypeError);
  assert.deepEqual((await (await f.open()).load()).map((event) => event.type), ['a', 'b', 'c']);
  await assert.rejects((await f.open()).save([]), TypeError, 'load before save');
});

test('a JSON journal written before is imported once and left byte for byte', async (t) => {
  const f = await folder(t);
  const events = [{ seq: 1, at, type: 'graph-submitted' }, { seq: 2, at, type: 'graph-activated' }];
  const file = path.join(f.directory, 'task-events.json');
  const original = legacyFile(events);
  await writeFile(file, original, { mode: 0o600 });
  const store = await f.open();
  assert.deepEqual(await store.load(), events);
  await store.save([...events, { seq: 3, at, type: 'after-import' }]);
  assert.equal(await readFile(file, 'utf8'), original, 'the old file is never rewritten');
  // A later change to the old file is not imported again.
  await writeFile(file, legacyFile([{ seq: 1, at, type: 'stale' }]));
  assert.deepEqual((await (await f.open()).load()).map((event) => event.type), ['graph-submitted', 'graph-activated', 'after-import']);
});

test('corruption is reported and original bytes remain untouched', async (t) => {
  const f = await folder(t);
  const filename = path.join(f.directory, 'task-events.json');
  const original = '{broken journal';
  await writeFile(filename, original);
  const store = await f.open();
  await assert.rejects(store.load(), { code: 'E_TASK_STORE_CORRUPT' });
  assert.equal(await readFile(filename, 'utf8'), original);
  // Still refused on the next open: nothing was marked imported.
  await assert.rejects((await f.open()).load(), { code: 'E_TASK_STORE_CORRUPT' });
  await writeFile(filename, legacyFile([{ seq: 2, at, type: 'out-of-order' }]));
  await assert.rejects((await f.open()).load(), { code: 'E_TASK_STORE_CORRUPT' }, 'a valid checksum over a broken sequence');
});

test('a shared workflow store keeps the journal beside other parts and imports from the legacy folder', async (t) => {
  const f = await folder(t);
  const legacyDirectory = path.join(f.directory, 'task-graph');
  const workflow = openWorkflowStore({ directory: path.join(f.directory, 'workflow-store') });
  t.after(() => workflow.close());
  await mkdir(legacyDirectory, { mode: 0o700 });
  await writeFile(path.join(legacyDirectory, 'task-events.json'), legacyFile([{ seq: 1, at, type: 'from-json' }]), { mode: 0o600 });
  const shared = await openTaskStore({ store: workflow, legacyDirectory });
  assert.deepEqual((await shared.load()).map((event) => event.type), ['from-json']);
  shared.close(); // a shared store stays open for its owner
  assert.equal(workflow.events.count(), 1);
});

test('a long journal saved one event at a time reloads to the graphs the live scheduler built', async (t) => {
  const f = await folder(t);
  const store = await f.open();
  const callbacks = { execute: async () => undefined, interrupt: async () => undefined, requestApproval: async () => undefined, verifyReceipt: async () => true };
  const graph = await openTaskGraph({ store, ...callbacks });
  t.after(() => graph.close());
  const submit = (index) => graph.submitGraph({ graphId: `graph-${index}`, requestId: `request-${index}`, runId: 'run-bulk', parentTaskId: null,
    requestedBy: 'local-user', tasks: [{ taskId: 'a', ownerId: 'agent', sourceRef: 'source-a', dependsOn: [] }] });
  for (let index = 0; index < 400; index += 1) await submit(index);
  const reopened = await f.open();
  const loaded = await reopened.load();
  assert.equal(loaded.length, 400);
  const replay = await openTaskGraph({ store: reopened, ...callbacks });
  t.after(() => replay.close());
  const withoutHold = ({ recoveryHold, ...rest }) => rest;
  for (const graphId of ['graph-0', 'graph-200', 'graph-399']) {
    assert.deepEqual(withoutHold(replay.getGraph(graphId)), withoutHold(graph.getGraph(graphId)), 'a full replay equals the incremental projection');
  }
  assert.equal(replay.getGraph('graph-0').recoveryHold, true);
});
