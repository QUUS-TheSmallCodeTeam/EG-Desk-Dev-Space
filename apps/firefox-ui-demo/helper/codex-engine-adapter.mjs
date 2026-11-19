// Codex behind the EngineAdapter contract (engine-adapter.mjs). The internal
// reference is the Codex app-server shape, so every conversation method is a
// pass-through: the same native method, the same params object and the same
// call order the runtime used before adapters existed. Calls are not wrapped
// in async functions, so a synchronous failure stays synchronous.
import { publicAuthIdentityKey } from './codex-auth-state.mjs'
import { chatError } from './codex-chat-values.mjs'

export const CODEX_ENGINE_ID = 'codex'
// The shared login remains the default; owned profiles are explicit routes.
export const CODEX_ENGINE_PROFILE_ID = 'codex-default'
export const CODEX_CAPABILITIES = Object.freeze([
  'stream', 'resume', 'nativeHistory', 'interrupt', 'approvals.command', 'approvals.fileChange',
  'userInput', 'subagents', 'dynamicTools', 'boundedQa', 'modelSelect.perTurn',
  'effortSelect.perTurn', 'usage.rateLimits', 'ephemeralThreads', 'threadFork',
])

const publicVersion = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,40})?$/.test(value) ? value : null
const AUTH_METHODS = { chatgpt: 'chatgpt', chatgptAuthTokens: 'chatgpt', apikey: 'apiKey', apiKey: 'apiKey' }
const VERSION_STATUSES = new Set(['supported', 'untested', 'unsupported'])

/**
 * One /v1/state engines[] row from public bridge state only. auth is the
 * bridge's public auth snapshot; usage is usageDisplay() output; models is the
 * model/list catalog (codex-model-catalog.mjs) or null when unknown. No token,
 * credential location or executable path is read or returned.
 */
export function describeCodexEngine({ ready = false, starting = false, blocked = false, version = null, versionSupported = null, versionStatus = null, installed = null, auth = null, usage = null, residentProcesses = 0, models = null, extraProfiles = [], residentLimit = 1 } = {}) {
  const signedIn = auth?.isLoggedIn === true
  const added = (Array.isArray(extraProfiles) ? extraProfiles : []).filter(row => row && row.id !== CODEX_ENGINE_PROFILE_ID).map(row => ({
    id: row.id, label: typeof row.label === 'string' ? row.label : null, credentialStore: 'egdesk-owned', active: false, owned: true,
    status: row.runnable === true ? 'available' : 'notYet', auth: profileAuth(row.auth), usage: null, models: row.models ?? null,
  }))
  return {
    id: CODEX_ENGINE_ID, label: 'Codex',
    status: blocked ? 'disabled' : ready ? (signedIn ? 'ready' : 'loginRequired') : starting ? 'starting' : 'offline',
    version: publicVersion(version),
    // versionSupported: exact Context/QA schema contract; versionStatus: SUB-13 Chat range.
    versionSupported: typeof versionSupported === 'boolean' ? versionSupported : null,
    versionStatus: VERSION_STATUSES.has(versionStatus) ? versionStatus : null,
    // A reported version means the CLI ran; otherwise not known here.
    installed: typeof installed === 'boolean' ? installed : publicVersion(version) ? true : null,
    capabilities: [...CODEX_CAPABILITIES],
    profiles: [{
      id: CODEX_ENGINE_PROFILE_ID, label: 'ChatGPT', credentialStore: 'shared-user-default', active: true, owned: false, status: 'available',
      auth: profileAuth(auth),
      usage: usage ?? null,
    }, ...added],
    runtime: { residentProcesses: Number.isSafeInteger(residentProcesses) && residentProcesses > 0 ? residentProcesses : 0, residentLimit, idleTimeoutMs: null },
    models: Array.isArray(models) ? models : null,
  }
}

function profileAuth(auth) {
  const signedIn = auth?.isLoggedIn === true
  return {
    status: signedIn ? 'signedIn' : auth?.loginInProgress === true ? 'signingIn' : auth ? 'signedOut' : 'unknown',
    method: AUTH_METHODS[auth?.authMode] || null,
    account: signedIn && typeof auth.accountEmail === 'string' ? auth.accountEmail : null,
    planType: signedIn && typeof auth.planType === 'string' ? auth.planType : null,
  }
}

// SUB-04 ChatGPT sign-in modes. 'browser' opens the callback page
// (account/login/start type 'chatgpt'); 'device' shows a one-time code to type
// on the verification page, for when the browser cannot come back to the
// bridge (type 'chatgptDeviceCode', codex 0.162.1 LoginAccountParams). Flow
// pattern: agentclientprotocol/codex-acp src/CodexAcpClient.ts:301-354,
// :1342-1384 (Apache-2.0); the code here is our own. The user code is
// returned to the screen only: never logged, stored or put in lifecycle details.
export const CODEX_LOGIN_MODES = Object.freeze(['browser', 'device'])
const USER_CODE = /^(?=.{4,40}$)[A-Za-z0-9]{2,16}(?:-[A-Za-z0-9]{2,16}){0,3}$/

function boundedId(value) {
  return typeof value === 'string' && value.trim() && value.length <= 200 ? value : null
}

function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch { return null }
}

// The POST /auth/start body's mode; absent means the existing browser flow.
export function codexLoginMode(value) {
  if (value === undefined || value === null) return 'browser'
  if (CODEX_LOGIN_MODES.includes(value)) return value
  throw chatError('INVALID_LOGIN_MODE', "Login mode must be 'browser' or 'device'", 400)
}

export function codexLoginStartParams(mode) {
  return mode === 'device' ? { type: 'chatgptDeviceCode' } : { type: 'chatgpt' }
}

// account/login/start answer for the code-entry flow → the bridge auth state
// patch; anything but a complete device-code answer is refused.
export function codexDeviceLoginPatch(result) {
  const loginId = boundedId(result?.loginId)
  const verificationUrl = httpsUrl(result?.verificationUrl)
  const userCode = typeof result?.userCode === 'string' && USER_CODE.test(result.userCode) ? result.userCode : null
  if (result?.type !== 'chatgptDeviceCode' || !loginId || !verificationUrl || !userCode) throw new Error('Unexpected login response')
  return {
    loginInProgress: true, authSessionId: loginId, authUrl: null, verificationUrl, userCode,
    callbackUrl: null, loginMode: 'device', loginError: null, statusText: 'Signing in…',
  }
}

// POST /auth/start answer while a login is already running in the same mode,
// so the screen can show the same page link or code again.
export function codexLoginInProgressResponse(state) {
  const device = state?.loginMode === 'device'
  return {
    started: false, loginInProgress: true, loginId: state?.authSessionId ?? null, mode: device ? 'device' : 'browser',
    ...(device ? { verificationUrl: state.verificationUrl ?? null, userCode: state.userCode ?? null } : {}),
    message: device ? 'Codex code sign-in is already running.' : 'Codex browser login is already running.',
  }
}

// account/login/completed of a login that is no longer the running one (the
// browser login cancelled when the user switched to the code) must not end
// the new login. A success is never ignored: the account is signed in.
export function isStaleLoginFailure(params, currentLoginId) {
  return params?.success !== true && typeof params?.loginId === 'string' && params.loginId !== currentLoginId
}

export function createCodexEngineAdapter({ request, respond, getOwnerKey = () => null, isReady = () => true,
  describe = null, refresh = null, getModels = () => null, getBoardPeerContract = () => null, profiles = null } = {}) {
  const sinks = new Set()
  const deliver = (kind, value, profileId) => {
    for (const sink of [...sinks]) {
      if (profileId === undefined) sink[kind]?.(CODEX_ENGINE_ID, value)
      else sink[kind]?.(CODEX_ENGINE_ID, value, profileId)
    }
  }
  const shared = id => id == null || id === CODEX_ENGINE_PROFILE_ID
  const unavailable = () => chatError('ENGINE_PROFILE_NOT_FOUND', 'Unknown or unavailable Codex profile', 404)
  const scoped = () => { if (!profiles) throw unavailable(); return profiles }
  const call = (method, params, id) => shared(id) ? request(method, params) : scoped().request(id, method, params)
  const ready = id => shared(id) ? isReady() === true : profiles?.snapshot(id)?.auth?.isLoggedIn === true
  const models = id => {
    try { const list = shared(id) ? getModels() : profiles?.snapshot(id)?.models; return Array.isArray(list) ? list : null }
    catch { return null }
  }
  const boardPeerContract = id => {
    try {
      const proof = ready(id) && (shared(id) ? getBoardPeerContract() : profiles?.boardPeerContract?.(id))
      return typeof proof === 'string' && /^[a-f0-9]{64}$/.test(proof) ? proof : null
    } catch { return null }
  }
  const summary = () => describe ? describe() : describeCodexEngine({ ready: ready(), models: models() })
  return {
    id: CODEX_ENGINE_ID,
    describe: summary,
    refresh: async id => {
      if (!shared(id)) { await scoped().refresh(id, { restartSignedOut: true }); return summary() }
      return refresh ? refresh() : summary()
    },
    ...(profiles ? { ensureReady: id => shared(id) ? Promise.resolve() : profiles.ensureReady(id) } : {}),
    models,
    capabilities: () => new Set(CODEX_CAPABILITIES),
    ownerKey: id => shared(id) ? getOwnerKey() : publicAuthIdentityKey(profiles?.snapshot(id)?.auth),
    isReady: ready,
    startThread: (params, id) => call('thread/start', params, id),
    resumeThread: (params, id) => call('thread/resume', params, id),
    releaseThread: (threadId, id) => call('thread/unsubscribe', { threadId }, id),
    startTurn: (params, id) => call('turn/start', params, id),
    boardPeerContract,
    steerTurn(params, id, proof) {
      if (!proof || proof !== boardPeerContract(id)) throw chatError('BOARD_PEER_UNSUPPORTED', 'No matching verified peer-input contract on this slot', 409)
      return call('turn/steer', params, id)
    },
    interruptTurn: (threadId, turnId, id) => call('turn/interrupt', { threadId, turnId }, id),
    forkThread: (params, id) => call('thread/fork', params, id),
    // Preserve legacy shared-RPC response arity and reject old scoped ids even
    // if accidentally called without a profile.
    respond: (rpcId, result, error, id) => {
      if (!shared(id)) return scoped().respond(id, rpcId, result, error)
      if (typeof rpcId === 'string' && rpcId.startsWith('codex-profile:')) throw unavailable()
      return error === undefined ? respond(rpcId, result) : respond(rpcId, result, error)
    },
    request: call,
    subscribe(sink) {
      sinks.add(sink)
      return () => { sinks.delete(sink) }
    },
    notify: (message, id) => deliver('notification', message, id),
    serverRequest: (message, id) => deliver('serverRequest', message, id),
    connection: (state, id) => deliver('connection', { ready: state?.ready === true, ...(state?.processLost ? { processLost: true } : {}) }, id),
    dispose: async () => { await profiles?.dispose(); sinks.clear() },
  }
}
