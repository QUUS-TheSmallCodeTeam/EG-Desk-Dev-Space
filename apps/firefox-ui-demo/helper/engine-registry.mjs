import { chatError, publicText } from './codex-chat-values.mjs'
import { ENGINE_CAPABILITIES, ENGINE_IDS, ENGINE_STATUSES, engineError, validateEngineAdapter } from './engine-adapter.mjs'
import { publicModelRows } from './codex-model-catalog.mjs'
import { ENGINE_VERSION_STATUSES } from './egdesk-native-capabilities.mjs'

const AUTH_STATUSES = new Set(['signedIn', 'signedOut', 'signingIn', 'unknown'])
const token = (value, limit = 120) => typeof value === 'string' && value.trim() && value.length <= limit ? publicText(value, limit) : null
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
const publicVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/.test(value) ? value : null

function publicProfile(profile) {
  const auth = profile?.auth
  return {
    id: token(profile?.id) || 'unknown', label: token(profile?.label) || null,
    credentialStore: token(profile?.credentialStore, 60), active: profile?.active === true,
    // SUB-11: owned = an EG-Desk-owned private login folder; false = the shared CLI login.
    owned: profile?.owned === true, status: profile?.status === 'notYet' ? 'notYet' : 'available',
    auth: {
      status: AUTH_STATUSES.has(auth?.status) ? auth.status : 'unknown',
      method: token(auth?.method, 60), account: token(auth?.account, 320), planType: token(auth?.planType, 60),
    },
    ...(Object.hasOwn(profile || {}, 'models') ? { models: publicModelRows(profile.models) } : {}),
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
    // Exact experimental-schema contract (Codex Context/QA); null when not applicable.
    versionSupported: typeof descriptor?.versionSupported === 'boolean' ? descriptor.versionSupported : null,
    // SUB-13 Chat range: 'supported' (verified) | 'untested' | 'unsupported' | null (unknown).
    versionStatus: ENGINE_VERSION_STATUSES.includes(descriptor?.versionStatus) ? descriptor.versionStatus : null,
    // The engine's CLI was found (true), not found (false) or not checked yet (null).
    installed: typeof descriptor?.installed === 'boolean' ? descriptor.installed : null,
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

export const CLAUDE_ENGINE_PROFILE_ID = 'claude-default'
const CLAUDE_AUTH_STATUSES = new Set(['signedIn', 'signedOut', 'unknown'])
const STATUS_REASON = /^[A-Za-z][A-Za-z0-9_]{0,59}$/
const coreVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+/.test(value) ? value.split(/[-+]/)[0] : null

/**
 * The Claude engines[] row from the static CLI check (claude-engine-auth.mjs
 * snapshot: installed, version, versionStatus, auth) and, when the Claude
 * adapter is registered (D-S1 (b), 2026-10-24), its runtime state.
 *
 * Without `connection` the row is the listed-only form: 'decisionPending'
 * (SUB-12), no capabilities, nothing runnable. It stays for callers that list
 * Claude without running it.
 *
 * connection (claude-engine-adapter.mjs) → the real status, first match wins:
 *   disabled (adapter disposed) → offline 'notChecked' (no check yet) →
 *   notInstalled → versionUnsupported ('versionUnknown' | 'belowMinimum' |
 *   the refused system/init code, e.g. CLAUDE_CAPABILITIES_MISSING) →
 *   loginRequired (signed out) → offline 'authUnknown' (the CLI did not answer
 *   in the expected shape) → ready. A ready row carries statusReason
 *   'CLAUDE_API_KEY_DETECTED' while an API key in EG-Desk's environment waits
 *   for the user's confirmation (D-S4), so the screen can ask before sending.
 * The CLI keeps its own login (Keychain); EG-Desk never reads it (SUB-08).
 */
export function describeClaudeEngine({ version = null, versionStatus = null, installed = null, auth = null } = {}, connection = null) {
  const status = CLAUDE_AUTH_STATUSES.has(auth?.status) ? auth.status : 'unknown'
  const signedIn = status === 'signedIn'
  const live = connection && typeof connection === 'object' ? connection : null
  // SUB-11: the static check ran with the active profile's login folder, so
  // its auth belongs to the active row; the other profiles are not checked.
  const choices = Array.isArray(live?.profiles) && live.profiles.some(profile => profile?.active === true) ? live.profiles : [{ id: CLAUDE_ENGINE_PROFILE_ID, owned: false, active: true }]
  const profiles = installed === true ? choices.map(choice => choice.active === true ? {
    id: choice.id, label: choice.owned && typeof choice.label === 'string' ? choice.label : signedIn && typeof auth.label === 'string' ? auth.label : 'Claude',
    credentialStore: choice.owned ? 'egdesk-owned' : 'claude-cli', active: true, owned: choice.owned === true, status: 'available',
    auth: {
      status,
      method: signedIn && typeof auth.method === 'string' ? auth.method : null,
      account: signedIn && typeof auth.account === 'string' ? auth.account : null,
      planType: signedIn && typeof auth.planType === 'string' ? auth.planType : null,
    },
    usage: live && live.usage && typeof live.usage === 'object' && !Array.isArray(live.usage) ? live.usage : null,
  } : {
    id: choice.id, label: typeof choice.label === 'string' ? choice.label : null, credentialStore: choice.owned ? 'egdesk-owned' : 'claude-cli',
    active: false, owned: choice.owned === true, status: 'available', auth: { status: 'unknown' }, usage: null,
  }) : []
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0
  const runtime = live
    ? { residentProcesses: count(live.residentProcesses), residentLimit: count(live.residentLimit) || 2, idleTimeoutMs: Number.isSafeInteger(live.idleTimeoutMs) && live.idleTimeoutMs > 0 ? live.idleTimeoutMs : 300000 }
    : { residentProcesses: 0, residentLimit: 2, idleTimeoutMs: 300000 }
  const base = { id: 'claude', label: 'Claude', version, versionSupported: null, versionStatus, installed: typeof installed === 'boolean' ? installed : null }
  if (!live) return { ...base, status: 'decisionPending', statusReason: 'SUB-12', capabilities: [], profiles, runtime }
  const minVersion = coreVersion(live.minVersion)
  const core = coreVersion(version)
  const below = core && minVersion ? core.split('.').map(Number).reduce((order, part, i) => order || Math.sign(part - minVersion.split('.').map(Number)[i]), 0) < 0 : versionStatus === 'unsupported'
  const gate = typeof live.gateFailure === 'string' && STATUS_REASON.test(live.gateFailure) ? live.gateFailure : null
  const [rowStatus, statusReason] =
    live.disposed === true ? ['disabled', null]
      : installed === null ? ['offline', 'notChecked']
        : installed === false ? ['notInstalled', null]
          : !core ? ['versionUnsupported', 'versionUnknown']
            : below ? ['versionUnsupported', 'belowMinimum']
              : gate ? ['versionUnsupported', gate]
                : status === 'signedOut' ? ['loginRequired', null]
                  : status !== 'signedIn' ? ['offline', 'authUnknown']
                    : ['ready', live.apiKeyEnv?.detected?.length && live.apiKeyEnv.confirmed !== true ? 'CLAUDE_API_KEY_DETECTED' : null]
  return {
    ...base, status: rowStatus, ...(statusReason ? { statusReason } : {}),
    capabilities: Array.isArray(live.capabilities) ? [...live.capabilities] : [],
    profiles, runtime,
    models: Array.isArray(live.models) ? live.models : null,
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

  // Replaces the row of an engine already listed (a new static check); it
  // never lists a new engine or turns a runnable one into a listed one.
  updateListed(descriptor) {
    if (!this.listed.has(descriptor?.id)) throw chatError('INVALID_ENGINE_ADAPTER', 'Only a listed engine can be updated', 500)
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
