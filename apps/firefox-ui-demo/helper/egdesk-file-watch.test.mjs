import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createWorkflowEventBus } from './egdesk-event-bus.mjs'
import { createConnectedRootWatcher } from './egdesk-file-watch.mjs'
import { createEGDeskFileService } from './egdesk-file-service.mjs'

const OWNER = 'egdesk-local'
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

function fakeFs() {
  const watchers = []
  const timers = []
  return {
    watchers, timers,
    watch(folder, options, listener) {
      const watcher = { folder, options, listener, closed: false, handlers: {}, close() { this.closed = true }, on(name, handler) { this.handlers[name] = handler } }
      watchers.push(watcher)
      return watcher
    },
    setTimer(callback, ms) { const timer = { callback, ms, cleared: false }; timers.push(timer); return timer },
    clearTimer(timer) { timer.cleared = true },
    runTimers() { for (const timer of timers.splice(0)) if (!timer.cleared) timer.callback() },
  }
}

function collect(bus) {
  const events = []
  bus.subscribe({ owner: OWNER, topics: ['file.changed'] }, event => { events.push(event.payload) })
  return events
}

test('connected roots are watched recursively; changes are debounced per path and published with rootId + relative path only', async () => {
  const fs = fakeFs()
  const bus = createWorkflowEventBus()
  const events = collect(bus)
  const watcher = createConnectedRootWatcher({ bus, owner: OWNER, watch: fs.watch, setTimer: fs.setTimer, clearTimer: fs.clearTimer })
  assert.equal(watcher.watchRoot({ rootId: 'root-1', absolutePath: '/Users/me/Downloads' }), true)
  assert.deepEqual(fs.watchers[0].options, { recursive: true, persistent: false, encoding: 'utf8' })
  const emit = (type, name) => fs.watchers[0].listener(type, name)
  emit('change', 'report.pdf')
  emit('change', 'report.pdf')
  emit('rename', 'report.pdf')
  emit('change', `sub${path.sep}notes.txt`)
  emit('change', '../escape.txt')
  emit('change', null)
  assert.equal(fs.timers.length, 1, 'one trailing flush per root')
  fs.runTimers()
  await bus.flush()
  assert.deepEqual(events, [
    { rootId: 'root-1', relativePath: 'report.pdf', change: 'rename' },
    { rootId: 'root-1', relativePath: 'sub/notes.txt', change: 'change' },
  ])
  assert.equal(JSON.stringify(events).includes('/Users/me'), false, 'absolute paths never leave the watcher')
  watcher.close()
  assert.equal(fs.watchers[0].closed, true)
  emit('change', 'late.txt')
  assert.equal(fs.timers.length, 0)
})

test('folders, root handles, pending paths and event rate are all capped; refusals and drops are counted', async () => {
  const fs = fakeFs()
  let clock = 0
  const bus = createWorkflowEventBus()
  const events = collect(bus)
  const watcher = createConnectedRootWatcher({ bus, owner: OWNER, maxRoots: 2, maxRootIdsPerFolder: 2, maxPendingPaths: 3, maxEventsPerSecond: 2,
    watch: fs.watch, setTimer: fs.setTimer, clearTimer: fs.clearTimer, now: () => clock })
  assert.equal(watcher.watchRoot({ rootId: 'a1', absolutePath: '/data/a' }), true)
  assert.equal(watcher.watchRoot({ rootId: 'b1', absolutePath: '/data/b' }), true)
  assert.equal(watcher.watchRoot({ rootId: 'c1', absolutePath: '/data/c' }), false, 'a third folder is refused, not evicting a watched one')
  assert.equal(watcher.watchRoot({ rootId: 'x', absolutePath: 'relative/path' }), false)
  assert.equal(fs.watchers.length, 2)
  // The same folder picked again shares one OS watcher and keeps its newest handles.
  assert.equal(watcher.watchRoot({ rootId: 'a2', absolutePath: '/data/a/' }), true)
  assert.equal(watcher.watchRoot({ rootId: 'a3', absolutePath: '/data/a' }), true)
  assert.equal(fs.watchers.length, 2)
  for (const name of ['1.txt', '2.txt', '3.txt', '4.txt']) fs.watchers[0].listener('change', name)
  fs.runTimers()
  await bus.flush()
  assert.deepEqual(events.map(event => `${event.rootId}:${event.relativePath}`), ['a2:1.txt', 'a3:1.txt', 'a2:2.txt', 'a3:2.txt'])
  assert.deepEqual(watcher.snapshot(), { watchedRoots: 2, maxWatchedRoots: 2, refusedRoots: 1, droppedFileEvents: 2 })
  clock = 1000
  fs.watchers[0].listener('change', '5.txt')
  fs.runTimers()
  await bus.flush()
  assert.equal(events.length, 6)
  // A watcher error releases the folder; unwatching the last handle closes it.
  fs.watchers[1].handlers.error()
  assert.equal(fs.watchers[1].closed, true)
  assert.equal(watcher.unwatchRoot('a2'), true)
  assert.equal(fs.watchers[0].closed, false)
  assert.equal(watcher.unwatchRoot('a3'), true)
  assert.equal(fs.watchers[0].closed, true)
  assert.equal(watcher.snapshot().watchedRoots, 0)
})

test('a real connected folder reports a new file through fs.watch and stops after close', async t => {
  const folder = await realpath(await mkdtemp(path.join(os.tmpdir(), 'egdesk-watch-')))
  const bus = createWorkflowEventBus()
  const events = collect(bus)
  const watcher = createConnectedRootWatcher({ bus, owner: OWNER, debounceMs: 50 })
  t.after(async () => { watcher.close(); bus.close(); await rm(folder, { recursive: true, force: true }) })
  await mkdir(path.join(folder, 'inbox'))
  assert.equal(watcher.watchRoot({ rootId: 'root-real', absolutePath: folder }), true)
  await delay(150)
  await writeFile(path.join(folder, 'inbox', 'arrival.pdf'), 'pdf')
  for (let index = 0; index < 100 && !events.some(event => event.relativePath === 'inbox/arrival.pdf'); index += 1) await delay(50)
  assert.ok(events.some(event => event.rootId === 'root-real' && event.relativePath === 'inbox/arrival.pdf'), JSON.stringify(events))
  watcher.close()
  const count = events.length
  await writeFile(path.join(folder, 'after-close.txt'), 'x')
  await delay(200)
  assert.equal(events.length, count)
})

test('the file service tells the bridge about each connected root with its verified real path', async t => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'egdesk-root-hook-'))
  t.after(() => rm(folder, { recursive: true, force: true }))
  const registered = []
  const draftStore = { create() {}, get() {}, compareAndSwap() {} }
  const service = createEGDeskFileService({ draftStore, onRootRegistered: root => { registered.push(root); throw new Error('observer failure is ignored') } })
  const root = await service.registerRoot(folder)
  assert.deepEqual(registered, [{ rootId: root.rootId, absolutePath: await realpath(folder) }])
  await assert.rejects(service.registerRoot('relative/folder'), { code: 'INVALID_ROOT' })
  assert.equal(registered.length, 1)
})
