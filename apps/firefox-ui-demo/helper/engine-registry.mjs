import { chatError, publicText } from './codex-chat-values.mjs'
import { ENGINE_CAPABILITIES, ENGINE_IDS, ENGINE_STATUSES, engineError, validateEngineAdapter } from './engine-adapter.mjs'
import { publicModelRows } from './codex-model-catalog.mjs'

const AUTH_STATUSES = new Set(['signedIn', 'signedOut', 'signingIn', 'unknown'])
const token = (value, limit = 120) => typeof value === 'string' && value.trim() && value.length <= limit ? publicText(value, limit) : null
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
const publicVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/.test(value) ? value : null

function publicProfile(profile) {
  const auth = profile?.auth
  return {
    id: token(profile?.id) || 'unknown', label: token(profile?.label) || null,
    credentialStore: token(profile?.credentialStore, 60), active: profile?.active === true,
    auth: {
      status: AUTH_STATUSES.has(auth?.status) ? auth.status : 'unknown',
      method: token(auth?.method, 60), account: token(auth?.account, 320), planType: token(auth?.planType, 60),
    },
    usage: profile?.usage && typeof profile.usage === 'object' && !Array.isArray(profile.usage) ? JSON.parse(JSON.stringify(profile.usage)) : null,
  }
}

/**
 * One /v1/state engines[] row (design §7) rebuilt from an allow-list, so an
 * adapter cannot leak a token, credential location or executable path.
 */
export function publicEngineRow(descriptor, { isDefault = false } = {}) {
  const runtime = descriptor?.runtime
  return {
    id: descriptor.id, label: token(descriptor?.label, 80) || descriptor.id,
    status: ENGINE_STATUSES.includes(descriptor?.status) ? descriptor.status : 'offline',
    ...(token(descriptor?.statusReason, 60) ? { statusReason: token(descriptor.statusReason, 60) } : {}),
    version: publicVersion(descriptor?.version),
    versionSupported: typeof descriptor?.versionSupported === 'boolean' ? descriptor.versionSupported : null,
    isDefault,
    capabilities: (Array.isArray(descriptor?.capabilities) ? descriptor.capabilities : []).filter(name => ENGINE_CAPABILITIES.includes(name)),
    profiles: (Array.isArray(descriptor?.profiles) ? descriptor.profiles : []).slice(0, 8).map(publicProfile),
    runtime: { residentProcesses: count(runtime?.residentProcesses), residentLimit: count(runtime?.residentLimit), idleTimeoutMs: Number.isSafeInteger(runtime?.idleTimeoutMs) && runtime.idleTimeoutMs > 0 ? runtime.idleTimeoutMs : null },
    // Choosable models [{ id, displayName, isDefault, supportedEfforts, defaultEffort }],
    // or null when the engine has not listed them (unknown, never invented).
    models: publicModelRows(descriptor?.models),
  }
}

/**
 * SSE engine.status (design §7): check() sends { type: 'engine.status', v,
 * engines, ts } whenever the public engines[] rows differ from the last sent
 * ones (connection, sign-in or account change, model list), and nothing when
 * they are unchanged.
 */
export function createEngineStatusEmitter({ engines, emit, v = 1, now = Date.now }) {
  let last = null
  return {
    check() {
      let rows
      try { rows = engines() } catch { return false }
      const text = JSON.stringify(rows)
      if (text === last) return false
      last = text
      emit({ type: 'engine.status', v, engines: rows, ts: now() })
      return true
    },
  }
}

// Claude is listed but cannot run until the connection method is decided
// (SUB-12, decisions D1/D2). Stage 8 replaces this row with a real adapter.
export function describeClaudeEngine({ version = null } = {}) {
  return {
    id: 'claude', label: 'Claude', status: 'decisionPending', statusReason: 'SUB-12',
    version, versionSupported: null, capabilities: [], profiles: [],
    runtime: { residentProcesses: 0, residentLimit: 2, idleTimeoutMs: 300000 },
  }
}

/**
 * Registered engines can run turns. Described engines only appear in
 * /v1/state. A conversation's engine is: the request's engineId, else the
 * engine it is bound to, else the default; a request naming a different
 * engine than the binding is refused, never silently switched.
 */
export class EngineRegistry {
  constructor({ defaultEngineId = 'codex' } = {}) {
    this.defaultEngineId = defaultEngineId
    this.runnable = new Map()
    this.listed = new Map()
  }

  register(adapter) {
    validateEngineAdapter(adapter)
    if (this.runnable.has(adapter.id) || this.listed.has(adapter.id)) throw chatError('INVALID_ENGINE_ADAPTER', `Engine ${adapter.id} is registered twice`, 500)
    this.runnable.set(adapter.id, adapter)
    return adapter
  }

  describe(descriptor) {
    if (!ENGINE_IDS.includes(descriptor?.id) || this.runnable.has(descriptor.id) || this.listed.has(descriptor.id)) throw chatError('INVALID_ENGINE_ADAPTER', 'Listed engine has an unknown or duplicate id', 500)
    this.listed.set(descriptor.id, { ...descriptor })
  }

  get(engineId) { return this.runnable.get(engineId) || null }
  has(engineId) { return this.runnable.has(engineId) }
  adapters() { return [...this.runnable.values()] }

  require(engineId) {
    const adapter = typeof engineId === 'string' ? this.runnable.get(engineId) : null
    if (adapter) return adapter
    const listed = typeof engineId === 'string' ? this.listed.get(engineId) : null
    throw engineError('ENGINE_UNAVAILABLE', listed?.status === 'decisionPending'
      ? `${listed.label || engineId} is listed but not connected yet; its connection method is still being decided`
      : 'The requested AI engine is not available')
  }

  resolve({ requested = null, bound = null } = {}) {
    if (requested != null) {
      this.require(requested)
      if (bound && bound !== requested) throw engineError('ENGINE_MISMATCH', 'This conversation runs on another AI engine; continue in a new conversation')
      return requested
    }
    return this.require(bound || this.defaultEngineId).id
  }

  assertReady(engineId) {
    const adapter = this.require(engineId)
    if (!adapter.isReady()) throw engineError('ENGINE_UNAVAILABLE', `${engineId} is offline`)
    return adapter
  }

  publicEngines() {
    const rows = []
    for (const adapter of this.runnable.values()) {
      let descriptor = null
      try { descriptor = adapter.describe() } catch {}
      rows.push(publicEngineRow({ ...(descriptor || { status: 'offline' }), id: adapter.id }, { isDefault: adapter.id === this.defaultEngineId }))
    }
    for (const descriptor of this.listed.values()) rows.push(publicEngineRow(descriptor, { isDefault: false }))
    return rows
  }
}
