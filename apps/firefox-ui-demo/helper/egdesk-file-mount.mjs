import { isBuiltin } from 'node:module'
import path from 'node:path'
import { createEGDeskFileHttpAdapter } from './egdesk-file-http.mjs'
import { createEGDeskNativeCreateOnlyAdapter } from './egdesk-file-native.mjs'
import { FileSurfaceError } from './egdesk-file-service.mjs'

export const MINIMUM_NODE_VERSION = '24.0.0'
export const INTEGRATION_NODE_VERSION = '24.11.1'

// Check before opening SQLite, creating a data directory, or starting Codex.
// The baseline is evidence from integration, not a claim about every newer Node.
export function requireEGDeskNodeRuntime({ version = process.versions.node, hasSqlite = isBuiltin('node:sqlite') } = {}) {
  const match = typeof version === 'string' && version.match(/^(\d+)\.(\d+)\.(\d+)$/)
  if (!match || Number(match[1]) < 24) {
    throw Object.assign(new Error(`EG-Desk requires Node.js ${MINIMUM_NODE_VERSION} or newer for managed file drafts (node:sqlite); detected ${version || 'unknown'}. Integration baseline: Node.js ${INTEGRATION_NODE_VERSION}. Use a supported Node executable to start the bridge.`), { code: 'EGDESK_NODE_VERSION_REQUIRED' })
  }
  if (!hasSqlite) {
    throw Object.assign(new Error(`Node.js ${version} does not provide node:sqlite. EG-Desk managed file drafts require a Node.js 24+ build with this builtin; integration baseline: ${INTEGRATION_NODE_VERSION}.`), { code: 'EGDESK_SQLITE_REQUIRED' })
  }
  return Object.freeze({ version, minimumVersion: MINIMUM_NODE_VERSION, integrationBaseline: INTEGRATION_NODE_VERSION, sqliteBuiltin: true })
}

// Product-local file authority is intentionally not derived from Codex auth,
// HTTP body fields, or the subscription account. The adapter owns body bounds.
export function createEGDeskFileMount({ dataDir, port = 39218, nativeExecutable, nodeRuntime = {}, platform = process.platform, createHttpAdapter = createEGDeskFileHttpAdapter, createNativeAdapter = createEGDeskNativeCreateOnlyAdapter, onRootRegistered = null } = {}) {
  const runtime = requireEGDeskNodeRuntime(nodeRuntime)
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('File dataDir must be an absolute app-owned path')
  // The descriptor-relative helper currently implements POSIX only. Keep
  // managed drafts/reading available on Windows without advertising Save As.
  const native = platform === 'win32' && createNativeAdapter === createEGDeskNativeCreateOnlyAdapter
    ? { capability: 'unavailable', async createFile() {
      throw Object.assign(new Error('Descriptor-relative native Save As is unavailable on Windows'),
        { code: 'EGDESK_NATIVE_UNAVAILABLE', created: false, fileMayExist: false })
    } }
    : createNativeAdapter(nativeExecutable === undefined ? {} : { executable: nativeExecutable })
  const createOnlyAdapter = {
    capability: native.capability,
    async createFile(args) {
      try { return await native.createFile(args) }
      catch (cause) {
        if (cause?.code === 'EGDESK_NATIVE_REFUSED' && cause.nativeStatus === 5 && cause.created === false && cause.fileMayExist !== true) {
          throw new FileSurfaceError('TARGET_EXISTS', 'Save As never overwrites an existing file', { created: false, fileMayExist: false })
        }
        if (!/^EGDESK_NATIVE_[A-Z_]+$/.test(cause?.code || '')) throw cause
        const failure = new FileSurfaceError(cause.code, cause.message, {
          created: cause.created ?? null, fileMayExist: cause.fileMayExist !== false,
          ...(Number.isInteger(cause.nativeStatus) ? { nativeStatus: cause.nativeStatus } : {}),
        })
        failure.httpStatus = cause.code === 'EGDESK_NATIVE_UNAVAILABLE' ? 503 : cause.code === 'EGDESK_NATIVE_TIMEOUT' ? 504 : 500
        throw failure
      }
    },
  }
  // onRootRegistered({rootId, absolutePath}) lets the bridge watch a connected
  // root (RT-06); it is backend-only and never sees a renderer-supplied path.
  const adapter = createHttpAdapter({ draftDirectory: path.join(dataDir, 'file-drafts'), localOwnerScope: 'egdesk-local', createOnlyAdapter, port, ...(onRootRegistered ? { onRootRegistered } : {}) })
  // Backend-only bridge from local file authority into immutable context.
  // Renderer bodies provide opaque references, never bytes, paths or an owner.
  const managedFileView = Object.freeze({
    ownerScope: 'egdesk-local',
    resolveCaptureSource: ({ captureRef, assertActive }) => adapter.resolveCaptureSource({ ownerScope: 'egdesk-local', captureRef, assertActive }),
  })
  return {
    runtime,
    managedFileView,
    // Server-only chat hook. IDs select existing associations; neither a UI
    // path nor an AI account can change this mount's local file authority.
    resolveProjectWorkspace: ({ boardId = null, roomId = null, projectTarget, expectedRoomProject } = {}) => adapter.resolveProjectWorkspace({ ownerScope: 'egdesk-local', boardId, roomId,
      ...(projectTarget !== undefined ? { projectTarget } : {}), ...(expectedRoomProject !== undefined ? { expectedRoomProject } : {}) }),
    resolveRunProjectOrigin: ({ origin, assertActive } = {}) => adapter.resolveRunProjectOrigin({ ownerScope: 'egdesk-local', origin, assertActive }),
    handle: (req, res, url) => adapter.handle(req, res, { url }),
    close: () => adapter.close(),
  }
}
