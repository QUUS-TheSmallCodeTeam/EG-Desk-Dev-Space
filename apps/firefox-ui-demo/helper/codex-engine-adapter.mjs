// Codex behind the EngineAdapter contract (engine-adapter.mjs). The internal
// reference is the Codex app-server shape, so every conversation method is a
// pass-through: the same native method, the same params object and the same
// call order the runtime used before adapters existed. Calls are not wrapped
// in async functions, so a synchronous failure stays synchronous.
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

/**
 * One /v1/state engines[] row from public bridge state only. auth is the
 * bridge's public auth snapshot; usage is usageDisplay() output. No token,
 * credential location or executable path is read or returned.
 */
export function describeCodexEngine({ ready = false, starting = false, blocked = false, version = null, versionSupported = null, auth = null, usage = null, residentProcesses = 0 } = {}) {
  const signedIn = auth?.isLoggedIn === true
  return {
    id: CODEX_ENGINE_ID, label: 'Codex',
    status: blocked ? 'disabled' : ready ? (signedIn ? 'ready' : 'loginRequired') : starting ? 'starting' : 'offline',
    version: publicVersion(version),
    versionSupported: typeof versionSupported === 'boolean' ? versionSupported : null,
    capabilities: [...CODEX_CAPABILITIES],
    profiles: [{
      id: CODEX_ENGINE_PROFILE_ID, label: 'ChatGPT', credentialStore: 'shared-user-default', active: true,
      auth: {
        status: signedIn ? 'signedIn' : auth?.loginInProgress === true ? 'signingIn' : auth ? 'signedOut' : 'unknown',
        method: AUTH_METHODS[auth?.authMode] || null,
        account: signedIn && typeof auth.accountEmail === 'string' ? auth.accountEmail : null,
        planType: signedIn && typeof auth.planType === 'string' ? auth.planType : null,
      },
      usage: usage ?? null,
    }],
    runtime: { residentProcesses: Number.isSafeInteger(residentProcesses) && residentProcesses > 0 ? residentProcesses : 0, residentLimit: 1, idleTimeoutMs: null },
  }
}

export function createCodexEngineAdapter({ request, respond, getOwnerKey = () => null, isReady = () => true, describe = null, refresh = null } = {}) {
  const sinks = new Set()
  const deliver = (kind, value) => { for (const sink of [...sinks]) sink[kind]?.(CODEX_ENGINE_ID, value) }
  return {
    id: CODEX_ENGINE_ID,
    describe: () => describe ? describe() : describeCodexEngine({ ready: isReady() }),
    refresh: async () => refresh ? refresh() : (describe ? describe() : describeCodexEngine({ ready: isReady() })),
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
