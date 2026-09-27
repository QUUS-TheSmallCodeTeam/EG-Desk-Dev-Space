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
export function createEGDeskFileMount({ dataDir, port = 39218, nativeExecutable, nodeRuntime = {}, createHttpAdapter = createEGDeskFileHttpAdapter, createNativeAdapter = createEGDeskNativeCreateOnlyAdapter } = {}) {
  const runtime = requireEGDeskNodeRuntime(nodeRuntime)
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir)) throw new TypeError('File dataDir must be an absolute app-owned path')
  const native = createNativeAdapter(nativeExecutable === undefined ? {} : { executable: nativeExecutable })
  const createOnlyAdapter = {
    capability: native.capability,
    async createFile(args) {
      try { return await native.createFile(args) }
      catch (cause) {
        if (cause?.code === 'EGDESK_NATIVE_REFUSED' && cause.nativeStatus === 5 && cause.created === false) {
          throw new FileSurfaceError('TARGET_EXISTS', 'Save As never overwrites an existing file', { created: false, fileMayExist: true })
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
  const adapter = createHttpAdapter({ draftDirectory: path.join(dataDir, 'file-drafts'), localOwnerScope: 'egdesk-local', createOnlyAdapter, port })
  return {
    runtime,
    handle: (req, res, url) => adapter.handle(req, res, { url }),
    close: () => adapter.close(),
  }
}
