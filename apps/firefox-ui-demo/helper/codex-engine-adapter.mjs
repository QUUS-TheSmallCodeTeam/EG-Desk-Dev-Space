// Codex behind the EngineAdapter contract (engine-adapter.mjs). The internal
// reference is the Codex app-server shape, so every conversation method is a
// pass-through: the same native method, the same params object and the same
// call order the runtime used before adapters existed. Calls are not wrapped
// in async functions, so a synchronous failure stays synchronous.
import { chatError } from './codex-chat-values.mjs'

export const CODEX_ENGINE_ID = 'codex'
// The one shared login (CODEX_HOME) the bridge uses today (SUB-11).
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
export function describeCodexEngine({ ready = false, starting = false, blocked = false, version = null, versionSupported = null, versionStatus = null, installed = null, auth = null, usage = null, residentProcesses = 0, models = null, extraProfiles = [] } = {}) {
  const signedIn = auth?.isLoggedIn === true
  // SUB-11: Codex is one shared app-server (one CODEX_HOME). Added ChatGPT
  // profiles are listed as 'notYet' and never active until a per-profile
  // app-server exists.
  const added = (Array.isArray(extraProfiles) ? extraProfiles : []).filter(row => row && row.id !== CODEX_ENGINE_PROFILE_ID).map(row => ({
    id: row.id, label: typeof row.label === 'string' ? row.label : null, credentialStore: 'egdesk-owned', active: false, owned: true, status: 'notYet',
    auth: { status: 'unknown' }, usage: null,
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
      auth: {
        status: signedIn ? 'signedIn' : auth?.loginInProgress === true ? 'signingIn' : auth ? 'signedOut' : 'unknown',
        method: AUTH_METHODS[auth?.authMode] || null,
        account: signedIn && typeof auth.accountEmail === 'string' ? auth.accountEmail : null,
        planType: signedIn && typeof auth.planType === 'string' ? auth.planType : null,
      },
      usage: usage ?? null,
    }, ...added],
    runtime: { residentProcesses: Number.isSafeInteger(residentProcesses) && residentProcesses > 0 ? residentProcesses : 0, residentLimit: 1, idleTimeoutMs: null },
    models: Array.isArray(models) ? models : null,
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

export function createCodexEngineAdapter({ request, respond, getOwnerKey = () => null, isReady = () => true, describe = null, refresh = null, getModels = () => null } = {}) {
  const sinks = new Set()
  const deliver = (kind, value) => { for (const sink of [...sinks]) sink[kind]?.(CODEX_ENGINE_ID, value) }
  const models = () => { try { const list = getModels(); return Array.isArray(list) ? list : null } catch { return null } }
  return {
    id: CODEX_ENGINE_ID,
    describe: () => describe ? describe() : describeCodexEngine({ ready: isReady(), models: models() }),
    refresh: async () => refresh ? refresh() : (describe ? describe() : describeCodexEngine({ ready: isReady(), models: models() })),
    // Optional ('modelSelect.perTurn'): the models a turn may name, or null
    // when unknown; the runtime checks a requested model and effort against it.
    models,
    capabilities: () => new Set(CODEX_CAPABILITIES),
    // One shared login today, so every engine profile names the same account.
    ownerKey: () => getOwnerKey(),
    isReady: () => isReady() === true,
    startThread: params => request('thread/start', params),
    resumeThread: params => request('thread/resume', params),
    releaseThread: threadId => request('thread/unsubscribe', { threadId }),
    startTurn: params => request('turn/start', params),
    interruptTurn: (threadId, turnId) => request('turn/interrupt', { threadId, turnId }),
    forkThread: params => request('thread/fork', params),
    // Arity is preserved: callers distinguish a result from a JSON-RPC error.
    respond: (id, result, error) => error === undefined ? respond(id, result) : respond(id, result, error),
    // Codex-only escape hatch: config/read, bounded-QA proofs and the
    // Context Reader keep talking to app-server directly.
    request: (method, params) => request(method, params),
    subscribe(sink) {
      sinks.add(sink)
      return () => { sinks.delete(sink) }
    },
    // The bridge feeds app-server traffic in; subscribers receive it tagged.
    notify: message => deliver('notification', message),
    serverRequest: message => deliver('serverRequest', message),
    connection: state => deliver('connection', { ready: state?.ready === true, ...(state?.processLost ? { processLost: true } : {}) }),
    dispose: async () => { sinks.clear() },
  }
}
