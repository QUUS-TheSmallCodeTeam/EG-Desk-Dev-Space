import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDownloadsAdapter } from '../overlay/resources/EGDeskDownloads.sys.mjs';

const explicit = { explicitUserRequest: true };

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function download(overrides = {}) {
  const calls = { cancel: 0, start: 0, launch: 0, show: 0 };
  const value = {
    source: { url: 'https://example.test/report', browsingContextId: 10, userContextId: 1, isPrivate: false },
    target: { path: '/native/report.pdf', partFilePath: '/native/report.pdf.part' },
    saver: { entityID: 'native-resumable-source' },
    stopped: false, succeeded: false, canceled: false, error: null,
    hasPartialData: false, hasBlockedData: false,
    currentBytes: 20, totalBytes: 100, progress: 20,
    async cancel() {
      calls.cancel += 1;
      this.canceled = true;
      this.stopped = true;
      this.hasPartialData = this.tryToKeepPartialData === true;
    },
    start() {
      calls.start += 1;
      this.stopped = false;
      this.canceled = false;
      return new Promise(() => {});
    },
    async launch() { calls.launch += 1; },
    async showContainingDirectory() { calls.show += 1; },
    ...overrides,
  };
  return { value, calls };
}

function fixture(items = []) {
  const views = new Set();
  const events = [];
  const files = new Map([
    ['/native/report.pdf', { type: 'regular', size: 100, lastModified: 12345 }],
    ['/native/report.pdf.part', { type: 'regular', size: 20, lastModified: 12344 }],
  ]);
  const list = {
    addView(view) {
      views.add(view);
      for (const item of items) view.onDownloadAdded(item);
    },
    removeView(view) { views.delete(view); },
  };
  const downloads = { ALL: Symbol('ALL'), async getList(kind) {
    assert.equal(kind, this.ALL);
    return list;
  } };
  const ioUtils = { async stat(path) {
    if (!files.has(path)) throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
    return { ...files.get(path) };
  } };
  return { downloads, ioUtils, onChange: (event) => events.push(event),
    views, events, files, list };
}

test('scoped native observer list uses exact browser context and leaves association unknown', async () => {
  const a = download();
  const b = download({ source: { url: a.value.source.url, browsingContextId: 20, userContextId: 1 } });
  const unknown = download({ source: { url: a.value.source.url, userContextId: 1 } });
  const native = fixture([a.value, b.value, unknown.value]);
  const adapter = await openDownloadsAdapter(native);
  assert.deepEqual(await adapter.start(), { supported: true, mode: 'injected', observing: true });
  assert.equal(native.views.size, 1);
  const all = await adapter.list();
  assert.equal(all.length, 3);
  assert.equal(all[0].idScope, 'adapter-session');
  assert.equal(all[0].nativeId, null);
  assert.equal(all[2].association, 'unknown');
  assert.equal(all[2].boardRef, null);
  assert.equal(all[2].cookieStoreId, null);
  assert.deepEqual((await adapter.list({ browsingContextId: 10 })).map((item) => item.id), [all[0].id]);
  assert.equal((await adapter.list({ browsingContextId: 10, includeUnknown: true })).length, 2);
  assert.equal((await adapter.search('report', { browsingContextId: 20 })).length, 1);
  const view = [...native.views][0];
  view.onDownloadRemoved(a.value);
  view.onDownloadChanged(a.value);
  assert.equal(await adapter.get(all[0].id), null, 'late change must not resurrect removed item');
  await adapter.stop();
  assert.equal(native.views.size, 0);
  const eventCount = native.events.length;
  view.onDownloadAdded(a.value);
  assert.equal(native.events.length, eventCount);
  assert.deepEqual(await adapter.list(), []);
  assert.equal(a.calls.cancel, 0, 'observer shutdown does not own native transfers');
});

test('open requires native completion, a current regular final file, and explicit action', async () => {
  const complete = download({ stopped: true, succeeded: true, progress: 100 });
  const native = fixture([complete.value]);
  const adapter = await openDownloadsAdapter(native);
  await adapter.start();
  const [item] = await adapter.list();
  assert.equal(item.status, 'completed');
  assert.equal(item.canOpen, true);
  assert.deepEqual(item.file, { path: '/native/report.pdf', size: 100, lastModified: 12345 });
  assert.equal(complete.calls.launch, 0);
  assert.equal((await adapter.open(item.id)).status, 'denied');
  assert.equal((await adapter.open(item.id, explicit)).status, 'launch-requested');
  assert.equal(complete.calls.launch, 1);
  native.files.delete('/native/report.pdf');
  assert.equal((await adapter.get(item.id)).canOpen, false);
  assert.equal((await adapter.open(item.id, explicit)).status, 'not-openable');
  assert.equal(complete.calls.launch, 1);
  await adapter.stop();
});

test('cancelled, failed, blocked, and cancellation-in-flight are never completed files', async () => {
  const cancelled = download({ stopped: true, canceled: true, hasPartialData: true });
  const failed = download({ stopped: true, error: { becauseSourceFailed: true }, hasPartialData: true });
  const blocked = download({ stopped: true, error: { becauseBlockedByReputationCheck: true }, hasPartialData: true });
  const cancelling = download({ canceled: true, stopped: false });
  const native = fixture([cancelled.value, failed.value, blocked.value, cancelling.value]);
  const adapter = await openDownloadsAdapter(native);
  await adapter.start();
  const items = await adapter.list();
  assert.deepEqual(items.map((item) => item.status), ['cancelled', 'failed', 'failed', 'cancelling']);
  assert(items.every((item) => !item.canOpen && item.file === null));
  assert.equal(items[1].error.becauseSourceFailed, true);
  assert.equal(items[2].canResume, false);
  assert.equal((await adapter.resume(items[2].id, explicit)).status, 'unsupported');
  for (const item of items) assert.equal((await adapter.open(item.id, explicit)).status, 'not-openable');
  await adapter.stop();
});

test('file inspection cannot enable open after native state/path changes or removal', async () => {
  const complete = download({ stopped: true, succeeded: true });
  const native = fixture([complete.value]);
  const adapter = await openDownloadsAdapter(native);
  await adapter.start();
  const [item] = await adapter.list();
  let gate = deferred();
  native.ioUtils.stat = async () => { await gate.promise; return { type: 'regular', size: 100 }; };
  const pending = adapter.get(item.id);
  complete.value.target.path = '/native/other.pdf';
  gate.resolve();
  assert.equal((await pending).canOpen, false);
  gate = deferred();
  const pendingOpen = adapter.open(item.id, explicit);
  [...native.views][0].onDownloadRemoved(complete.value);
  gate.resolve();
  assert.equal((await pendingOpen).status, 'not-openable');
  assert.equal(complete.calls.launch, 0);
  await adapter.stop();
});

test('pause/resume use native partial evidence and never auto-run completion actions', async () => {
  const active = download();
  const native = fixture([active.value]);
  const adapter = await openDownloadsAdapter(native);
  await adapter.start();
  const [item] = await adapter.list();
  assert.equal((await adapter.pause(item.id, explicit)).status, 'paused');
  assert.equal(active.calls.cancel, 1);
  assert.equal((await adapter.get(item.id)).canResume, true);
  assert.equal((await adapter.resume(item.id, explicit)).status, 'resume-requested');
  assert.equal(active.calls.start, 1);
  assert.equal(active.calls.launch, 0);
  assert.equal((await adapter.cancel(item.id, explicit)).status, 'cancelled');
  assert.equal((await adapter.show(item.id, explicit)).status, 'show-requested');
  assert.equal(active.calls.show, 1);
  native.files.delete('/native/report.pdf.part');
  assert.equal((await adapter.resume(item.id, explicit)).status, 'unsupported');
  assert.equal(active.calls.start, 1);
  await adapter.stop();
});

test('concurrent startup shares one observer and stop fences delayed startup', async () => {
  const native = fixture();
  const gate = deferred();
  native.downloads.getList = async () => { await gate.promise; return native.list; };
  const adapter = await openDownloadsAdapter(native);
  const first = adapter.start();
  const second = adapter.start();
  const stopping = adapter.stop();
  gate.resolve();
  await Promise.all([first, second, stopping]);
  assert.equal(native.views.size, 0);
  await Promise.all([adapter.start(), adapter.start()]);
  assert.equal(native.views.size, 1);
  await adapter.stop();
  assert.equal(native.views.size, 0);
});

test('stop during native addView removes its observer and ignores late callbacks', async () => {
  const item = download();
  const native = fixture([item.value]);
  const entered = deferred();
  const gate = deferred();
  native.list.addView = async (view) => {
    native.views.add(view);
    view.onDownloadAdded(item.value);
    entered.resolve();
    await gate.promise;
  };
  const adapter = await openDownloadsAdapter(native);
  const starting = adapter.start();
  await entered.promise;
  const oldView = [...native.views][0];
  const stopping = adapter.stop();
  oldView.onDownloadChanged(item.value);
  gate.resolve();
  await Promise.all([starting, stopping]);
  assert.equal(native.views.size, 0);
  assert.equal(native.events.length, 1);
  assert.deepEqual(await adapter.list(), []);
});

test('unsupported environment and fresh adapter IDs cannot look like native completion', async () => {
  const unavailable = await openDownloadsAdapter({ downloads: null, ioUtils: null });
  assert.equal((await unavailable.start()).supported, false);
  assert.deepEqual(await unavailable.list(), []);
  const item = download();
  const native = fixture([item.value]);
  const first = await openDownloadsAdapter(native);
  const second = await openDownloadsAdapter(native);
  await first.start();
  await second.start();
  const [a] = await first.list();
  const [b] = await second.list();
  assert.notEqual(a.id, b.id);
  assert.equal((await second.cancel(a.id, explicit)).status, 'unavailable');
  await first.stop();
  await second.stop();
});

test('Gecko entry point imports Downloads and uses native IO through a fake host boundary', async () => {
  const native = fixture([download({ stopped: true, succeeded: true }).value]);
  const savedChrome = globalThis.ChromeUtils;
  const savedIO = globalThis.IOUtils;
  const imports = [];
  try {
    globalThis.ChromeUtils = { importESModule(uri) {
      imports.push(uri);
      return { Downloads: native.downloads };
    } };
    globalThis.IOUtils = native.ioUtils;
    const adapter = await openDownloadsAdapter();
    assert.equal((await adapter.start()).mode, 'gecko-native');
    assert.deepEqual(imports, ['resource://gre/modules/Downloads.sys.mjs']);
    assert.equal((await adapter.list())[0].canOpen, true);
    await adapter.stop();
    assert.equal(native.views.size, 0);
  } finally {
    if (savedChrome === undefined) delete globalThis.ChromeUtils;
    else globalThis.ChromeUtils = savedChrome;
    if (savedIO === undefined) delete globalThis.IOUtils;
    else globalThis.IOUtils = savedIO;
  }
});

test('a failed native list startup can be retried without retaining an observer', async () => {
  const native = fixture();
  let calls = 0;
  native.downloads.getList = async () => {
    if (++calls === 1) throw new Error('native list temporarily unavailable');
    return native.list;
  };
  const adapter = await openDownloadsAdapter(native);
  await assert.rejects(adapter.start());
  assert.equal(native.views.size, 0);
  assert.equal((await adapter.start()).observing, true);
  assert.equal(native.views.size, 1);
  await adapter.stop();
});
