import { watch as fsWatch } from 'node:fs'
import path from 'node:path'
import { relativeRootPath } from './egdesk-event-bus.mjs'

/**
 * RT-06 file watcher for connected roots only (folders the user opened in a
 * File Card through the native picker). Never watches arbitrary paths.
 *
 * Bounds: at most maxRoots distinct folders (later ones are refused and
 * counted), per-root debounce, at most maxEventsPerSecond published per root,
 * at most maxPendingPaths distinct paths waiting per root. Events carry the
 * opaque rootId and the root-relative path only, never the absolute path.
 *
 * createConnectedRootWatcher({ bus, owner }) -> { watchRoot({rootId, absolutePath}), unwatchRoot(rootId), snapshot(), close() }
 */
export function createConnectedRootWatcher({
  bus, owner, maxRoots = 8, maxRootIdsPerFolder = 16, debounceMs = 250, maxEventsPerSecond = 20, maxPendingPaths = 64,
  watch = fsWatch, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now,
} = {}) {
  if (!bus?.publish) throw new TypeError('Workflow event bus is required')
  if (typeof owner !== 'string' || !owner) throw new TypeError('An owner scope is required')
  const folders = new Map() // absolute folder -> { watcher, rootIds:Set, pending:Map, timer, window }
  const folderOfRoot = new Map()
  let dropped = 0
  let refused = 0
  let closed = false

  function flush(folder, entry) {
    entry.timer = null
    if (closed || folders.get(folder) !== entry) return
    const changes = [...entry.pending]
    entry.pending.clear()
    for (const [relativePath, change] of changes) {
      const at = now()
      if (at - entry.window.start >= 1000) entry.window = { start: at, count: 0 }
      if (entry.window.count >= maxEventsPerSecond) { dropped += 1; continue }
      entry.window.count += 1
      for (const rootId of entry.rootIds) {
        try { bus.publish({ topic: 'file.changed', owner, payload: { rootId, relativePath, change } }) }
        catch { dropped += 1 }
      }
    }
  }

  function observe(folder, entry, eventType, filename) {
    if (closed || folders.get(folder) !== entry || filename == null) return
    const relativePath = relativeRootPath(String(filename).split(path.sep).join('/'))
    if (!relativePath) return
    if (!entry.pending.has(relativePath) && entry.pending.size >= maxPendingPaths) { dropped += 1; return }
    const change = eventType === 'rename' || entry.pending.get(relativePath) === 'rename' ? 'rename' : 'change'
    entry.pending.set(relativePath, change)
    // Trailing throttle, not a resettable debounce: constant writes still flush.
    if (!entry.timer) {
      entry.timer = setTimer(() => flush(folder, entry), debounceMs)
      entry.timer?.unref?.()
    }
  }

  function stopFolder(folder) {
    const entry = folders.get(folder)
    if (!entry) return
    folders.delete(folder)
    if (entry.timer) clearTimer(entry.timer)
    entry.timer = null
    entry.pending.clear()
    for (const rootId of entry.rootIds) folderOfRoot.delete(rootId)
    try { entry.watcher.close() } catch {}
  }

  function watchRoot({ rootId, absolutePath } = {}) {
    if (closed) return false
    if (typeof rootId !== 'string' || !rootId || rootId.length > 256) return false
    if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) return false
    const folder = path.resolve(absolutePath)
    const existing = folders.get(folder)
    if (existing) {
      if (!existing.rootIds.has(rootId)) {
        existing.rootIds.add(rootId)
        folderOfRoot.set(rootId, folder)
        // The same folder picked many times keeps only its newest handles.
        while (existing.rootIds.size > maxRootIdsPerFolder) {
          const oldest = existing.rootIds.values().next().value
          existing.rootIds.delete(oldest)
          folderOfRoot.delete(oldest)
        }
      }
      return true
    }
    if (folders.size >= maxRoots) { refused += 1; return false }
    const entry = { watcher: null, rootIds: new Set([rootId]), pending: new Map(), timer: null, window: { start: 0, count: 0 } }
    try {
      entry.watcher = watch(folder, { recursive: true, persistent: false, encoding: 'utf8' }, (eventType, filename) => observe(folder, entry, eventType, filename))
    } catch { refused += 1; return false }
    entry.watcher.on?.('error', () => stopFolder(folder))
    folders.set(folder, entry)
    folderOfRoot.set(rootId, folder)
    return true
  }

  function unwatchRoot(rootId) {
    const folder = folderOfRoot.get(rootId)
    if (!folder) return false
    const entry = folders.get(folder)
    folderOfRoot.delete(rootId)
    entry?.rootIds.delete(rootId)
    if (entry && !entry.rootIds.size) stopFolder(folder)
    return true
  }

  return {
    watchRoot, unwatchRoot,
    snapshot: () => ({ watchedRoots: folders.size, maxWatchedRoots: maxRoots, refusedRoots: refused, droppedFileEvents: dropped }),
    close() { closed = true; for (const folder of [...folders.keys()]) stopFolder(folder) },
  }
}
