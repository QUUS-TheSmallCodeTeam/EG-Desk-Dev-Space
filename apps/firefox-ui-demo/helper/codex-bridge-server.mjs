import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { AppServerRpc } from './codex-app-server-rpc.mjs'
import { normalizeNativeAuth, publicAuthIdentityKey, publicPlanType } from './codex-auth-state.mjs'
import { usageDisplay } from './codex-account-usage.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createChatEngineAuth } from './codex-bridge-engine-auth.mjs'
import { codexDeviceLoginPatch, codexLoginInProgressResponse, codexLoginMode, codexLoginStartParams, createCodexEngineAdapter, describeCodexEngine, isStaleLoginFailure } from './codex-engine-adapter.mjs'
import { EngineRegistry, createEngineStatusEmitter } from './engine-registry.mjs'
import { claudeLoginTerminalCommand, createClaudeEngineStatus, resolveClaudeExecutable } from './claude-engine-auth.mjs'
import { createClaudeEngineAdapter } from './claude-engine-adapter.mjs'
import { createModelCatalogSync } from './codex-model-catalog.mjs'
import { BrowserToolTransport } from './codex-browser-tool-transport.mjs'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { fixtureBrowserQaFromEnv } from './codex-browser-fixture-qa.mjs'
import { classifyPublicToolError } from './codex-tool-errors.mjs'
import { createChatHttpHandler, createComputerControlHttpHandler, createRateLimitSync, createReconnectBackoff, guardBridgeRequest, readJsonBody, sendJson, setBridgeCors } from './codex-bridge-http.mjs'
import { bridgeBuildState, expectedOverlayBuild, startBridgeBuild } from './egdesk-bridge-build.mjs'
import { createInheritedMcpSync } from './codex-inherited-mcp.mjs'
import { BoundedSseClient } from './codex-bridge-sse.mjs'
import { TerminalSessionRegistry } from './terminal-sessions.mjs'
import { createTerminalSessionFactory } from './terminal-platform.mjs'
import { createTerminalHttpHandler } from './terminal-http.mjs'
import { chatError, publicText } from './codex-chat-values.mjs'
import { randomBytes } from 'node:crypto'
import * as os from 'node:os'
import path from 'node:path'
import { ImmutableContextStore, appDataDirectory } from './egdesk-context-store.mjs'
import { openChatStore } from './egdesk-chat-store.mjs'
import { openProfileStore } from './egdesk-profile-store.mjs'
import { createProfileHttpHandler } from './egdesk-profile-http.mjs'
import { openDeskStore } from './egdesk-desk-store.mjs'
import { openBridgeSettings } from './egdesk-bridge-settings.mjs'
import { createDeskHttpHandler } from './egdesk-desk-http.mjs'
import { createPortableHttpHandler } from './egdesk-portable-http.mjs'
import { NativeReaderClient } from './egdesk-native-reader.mjs'
import { ClaudeReaderClient, estimateClaudeReaderInput } from './egdesk-claude-reader.mjs'
import { ContextRuntime } from './egdesk-context-runtime.mjs'
import { createContextHttpHandler } from './egdesk-context-http.mjs'
import { buildCodexAppServerLaunch, inspectNativeCapabilities, preflightOwnedAppServer, resolveCodexExecutable, NATIVE_SCHEMA_VERSION } from './egdesk-native-capabilities.mjs'
import { createEGDeskFileMount, requireEGDeskNodeRuntime } from './egdesk-file-mount.mjs'
import { createSystemResourceMonitor } from './system-resource-monitor.mjs'
import { openWorkflowRuntime } from './egdesk-workflow-runtime.mjs'
import { createPlanToolProvider } from './egdesk-plan-tool-provider.mjs'

const nodeRuntime = requireEGDeskNodeRuntime()

const BRIDGE_PORT = 39218
const APP_SERVER_PORT = 39219
const APP_SERVER_WS_URL = `ws://127.0.0.1:${APP_SERVER_PORT}`
const appServerLaunch = buildCodexAppServerLaunch({ env: process.env, listen: APP_SERVER_WS_URL })
const BRIDGE_PROTOCOL_VERSION = 1
const PROVIDER_ID = 'codex'
// Hash of the helper modules this process loaded, read once at start, so the
// overlay can tell a bridge left running on older source (/v1/state bridge).
const bridgeBuild = startBridgeBuild()

const clients = new Set()

let appServerProcess = null
let appServerSocket = null
let appServerReady = false
let reconnectTimer = null
const appServerBackoff = createReconnectBackoff()
let loginPollTimer = null
let rpc = null
let nativeCapabilities = { executable: null, version: null, schemaVersion: NATIVE_SCHEMA_VERSION, schemaMatch: false, experimentalApi: true, dynamicTools: false, readerReadOnly: false, qaReadOnly: false }
let launchConfigBlocked = false
let nativePreflight = {
  status: appServerLaunch.hasOverrides ? 'pending' : 'inherited',
  configuredModel: appServerLaunch.configuredModel, configuredEffort: appServerLaunch.configuredEffort,
  effectiveModel: null, effectiveEffort: null,
}
let memoryIsolation = { status: appServerLaunch.disableMemories ? 'pending' : 'not-requested', feature: 'memories' }

const authState = {
  isLoggedIn: false,
  authMode: null,
  accountId: null,
  accountEmail: null,
  planType: null,
  rateLimits: null,
  identityStatus: 'unknown',
  identityBasis: null,
  lastRefresh: null,
  source: 'app-server',
  statusText: 'Login required',
  loginInProgress: false,
  authSessionId: null,
  authUrl: null,
  verificationUrl: null,
  userCode: null,
  callbackUrl: null,
  loginMode: 'browser',
  requiresOpenaiAuth: true,
  loginError: null,
}

function broadcast(event, chatProtocol = 0) {
  const payload = `event: codex\ndata: ${JSON.stringify(event)}\n\n`
  for (const client of clients) {
    if (chatProtocol && client.chatProtocol !== chatProtocol) continue
    client.send(payload)
  }
}

function emitAuthStatus() {
  broadcast({
    type: 'auth.status',
    v: BRIDGE_PROTOCOL_VERSION,
    provider: PROVIDER_ID,
    status: authSnapshot(),
    ts: Date.now(),
  })
}

function emitAuthLifecycle(phase, details = {}) {
  broadcast({
    type: 'auth.lifecycle',
    v: BRIDGE_PROTOCOL_VERSION,
    provider: PROVIDER_ID,
    phase,
    status: authSnapshot(),
    details,
    ts: Date.now(),
  })
}

const nativeRespond = (id, result, error) => {
  if (!rpc) throw chatError('BRIDGE_OFFLINE', 'Codex app-server is offline', 503)
  rpc.respond(id, result, error)
}
const dataDir = appDataDirectory()
const systemResourceMonitor = createSystemResourceMonitor({ profilePath: dataDir })
let chatStore = null
let chatStoreError = null
try {
  chatStore = openChatStore({ dataDir: path.join(dataDir, 'chat'), ownerScope: 'local-desktop-v1' })
} catch (error) {
  chatStoreError = publicText(error?.message || 'Local chat storage failed to open', 1000)
  console.error('[egdesk-codex-bridge] local chat storage unavailable:', chatStoreError)
}
// Agent profiles are local data like chat history: a failure leaves Chat and
// the bridge running, and profile routes answer 503.
let profileStore = null
let profileStoreError = null
try {
  profileStore = openProfileStore({ dataDir: path.join(dataDir, 'chat'), ownerHash: 'local-desktop-v1' })
  profileStore.seedTemplates()
} catch (error) {
  profileStoreError = publicText(error?.message || 'Local profile storage failed to open', 1000)
  console.error('[egdesk-codex-bridge] local profile storage unavailable:', profileStoreError)
}
// RT-07/CTX-01/CTX-02 Desk recovery journal and saved Board revisions. A
// failure leaves the bridge running; /v1/desk and /v1/boards answer 503 and
// the screen keeps its preference values.
let deskStore = null
let deskStoreError = null
try {
  deskStore = openDeskStore({ dataDir: path.join(dataDir, 'desk'), ownerScope: 'local-desktop-v1' })
} catch (error) {
  deskStoreError = publicText(error?.message || 'Local Desk storage failed to open', 1000)
  console.error('[egdesk-codex-bridge] local Desk storage unavailable:', deskStoreError)
}
// CU-01: settings the user chose that outlive a restart (computer control).
// Never throws; a broken file is set aside and logged, and the bridge starts
// with defaults (computerControl.persisted then tells the screen).
const bridgeSettings = openBridgeSettings({ dataDir: path.join(dataDir, 'settings') })
// RT-06/CHAT-06 workflow runtime (event bus, connected-root watcher, task
// graph). Opened after Chat below; callbacks that fire earlier are no-ops.
let workflow = null
const localFiles = createEGDeskFileMount({ dataDir, port: BRIDGE_PORT, onRootRegistered: root => workflow?.watchRoot(root) })
const contextStore = new ImmutableContextStore({
  dataDir,
  managedFileView: localFiles.managedFileView,
  allowedRoots: process.env.EGDESK_CONTEXT_ROOTS ? process.env.EGDESK_CONTEXT_ROOTS.split(path.delimiter).filter(Boolean) : [process.cwd()],
})
const nativeReader = new NativeReaderClient({ request: (method, params) => appServerRequest(method, params), respond: nativeRespond, getOwnerKey: () => publicAuthIdentityKey(authState) })
// Stock get_context_usage supplies partial window/usage metadata, not the
// verified tool-output/estimator and managed-policy evidence strict B3 needs.
// No fixture, model-name table, caller window or Codex metadata is a substitute.
// Wire authoritative exports here when available; ordinary chat/B2 stay ready.
const getClaudeReadCapacity = () => null
const getClaudeReaderIsolationProof = () => null
let claudeReaderClient = null
const claudeReader = {
  estimateInput: estimateClaudeReaderInput,
  readiness(options) {
    if (!getClaudeReadCapacity(options)) return { ready: false, engineId: 'claude', code: 'ENGINE_CAPACITY_UNKNOWN' }
    return this.client().readiness(options)
  },
  client() {
    if (!claudeReaderClient) {
      const executablePath = resolveClaudeExecutable(process.env)
      if (!executablePath) throw chatError('ENGINE_NOT_INSTALLED', 'Claude Reader executable is unavailable', 409)
      claudeReaderClient = new ClaudeReaderClient({ executablePath, getScope: () => chat.contextAuthority({ engineId: 'claude' }),
        snapshot: () => claudeEngineStatus.snapshot(), getReadCapacity: getClaudeReadCapacity, getIsolationProof: getClaudeReaderIsolationProof })
    }
    return claudeReaderClient
  },
  read(options) {
    if (!getClaudeReadCapacity(options)) throw chatError('ENGINE_CAPACITY_UNKNOWN', 'Strict Claude Reader capacity is not verified; no native process was started', 409)
    return this.client().read(options)
  },
  disconnect(options) { return claudeReaderClient?.disconnect(options) },
}
const contexts = new ContextRuntime({
  store: contextStore, reader: nativeReader, readers: { claude: claudeReader }, getReadCapacity: getClaudeReadCapacity,
  getOwnerKey: () => publicAuthIdentityKey(authState),
  getAuthority: hints => chat.contextAuthority(hints),
  schemaReady: authority => authority?.engineId === 'claude'
    ? claudeEngine.isReady() && claudeEngine.capabilities().has('dynamicTools')
    : nativeCapabilities.schemaMatch && appServerReady,
})
const browserTransport = new BrowserToolTransport({ getOwnerKey: () => publicAuthIdentityKey(authState) })
const browserProvider = createCodexBrowserToolProvider({ transport: browserTransport, getOwnerKey: () => publicAuthIdentityKey(authState), schemaReady: () => nativeCapabilities.qaReadOnly && appServerReady, fixtureQa: fixtureBrowserQaFromEnv(process.env) })
// egdesk_propose_plan on ordinary threads: plans wait for approval in the
// workflow runtime opened below (null until then, so the tool answers unavailable).
const planProvider = createPlanToolProvider({ plans: () => workflow?.plans ?? null, schemaReady: () => nativeCapabilities.schemaMatch && appServerReady })
// The Codex models the signed-in account can choose (model/list, hidden ones
// excluded), read after each ready connection and on every account change;
// null while unknown or signed out. They fill the Codex engines[] row and
// bound /chat/send.
const modelCatalog = createModelCatalogSync({
  request: (method, params) => appServerRequest(method, params),
  ready: () => appServerReady && authState.isLoggedIn,
  identity: () => modelAccountKey(authState),
  onChange: () => engineStatus.check(),
})
// Each adapter owns its responses; the chat runtime routes engine RPC IDs.
const codexEngine = createCodexEngineAdapter({
  request: (method, params) => appServerRequest(method, params),
  respond: nativeRespond,
  getOwnerKey: () => publicAuthIdentityKey(authState),
  isReady: () => appServerReady,
  getModels: () => modelCatalog.snapshot(),
  describe: () => describeCodexEngine({
    ready: appServerReady, starting: Boolean(appServerProcess) && !appServerReady, blocked: launchConfigBlocked,
    version: nativeCapabilities.version, versionSupported: nativeCapabilities.version ? nativeCapabilities.schemaMatch : null,
    versionStatus: nativeCapabilities.versionStatus ?? null,
    auth: authState, usage: usageDisplay(authState.rateLimits, Date.now()),
    residentProcesses: appServerProcess && appServerProcess.exitCode == null ? 1 : 0,
    models: modelCatalog.snapshot(),
  }),
})
// D-S1 (b) (2026-10-24): the installed, unmodified `claude`, one child
// process per conversation over the SDK stdio control channel. Gated by the
// static check below (installed, version range, signed in); D-S2 isolation and
// D-S4 API key confirmation live in the adapter and its transport.
const claudeEngine = createClaudeEngineAdapter({
  snapshot: () => claudeEngineStatus.snapshot(),
  refreshStatus: options => claudeEngineStatus.refresh(options),
  defaultCwd: process.cwd(),
  onStatusChange: () => engineStatus.check(),
})
const engineRegistry = new EngineRegistry({ defaultEngineId: PROVIDER_ID })
engineRegistry.register(codexEngine)
engineRegistry.register(claudeEngine)
// SSE engine.status (design §7): sent whenever a public engines[] row changes
// (connection, sign-in or account change, model list), beside auth.status.
const engineStatus = createEngineStatusEmitter({
  engines: () => engineRegistry.publicEngines(),
  emit: event => broadcast(event),
  v: BRIDGE_PROTOCOL_VERSION,
})
// SUB-08/13: static Claude CLI check (`--version`, `auth status --json`) for
// the Claude row: installed, version range, signed-in plan and email. It
// never reads Keychain or credential files. A change re-gates the adapter;
// becoming ready (or not) reaches Chat as a Claude connection change.
const claudeEngineStatus = createClaudeEngineStatus({
  onChange: () => {
    claudeEngine.syncStatus()
    engineStatus.check()
  },
})
const chat = new CodexChatRuntime({
  engines: engineRegistry,
  contexts,
  toolProviders: [browserProvider, planProvider],
  store: chatStore,
  requireStore: true,
  getOwnerKey: () => publicAuthIdentityKey(authState),
  expectedProcessConfiguration: { model: appServerLaunch.configuredModel, effort: appServerLaunch.configuredEffort },
  qaReady: () => nativeCapabilities.qaReadOnly && appServerReady,
  getNativeContractFingerprint: () => nativeCapabilities.contractFingerprint,
  profiles: profileStore,
  emit: event => { broadcast(event, 2); workflow?.onChatEvent(event) },
  emitLegacy: event => broadcast(event, 1),
  // CU-01: an MCP call's controlKind also reads the inherited classification
  // (declared below; a Computer Use marker makes node_repl 'computer').
  mcpServerKind: name => inheritedMcp.kindOf(name),
  // CU-01 stage 1: the saved choice, else 'inherit' until the decision; POST
  // /settings/computer-control changes and saves it.
  computerControlStore: bridgeSettings.computerControl,
  onComputerControlChange: computerControl => broadcast({ type: 'computer.control', v: BRIDGE_PROTOCOL_VERSION, provider: PROVIDER_ID, computerControl, ts: Date.now() }),
})
// Claude conversation events reach the same runtime as app-server traffic.
claudeEngine.subscribe({
  notification: (_engineId, message) => { void chat.handleNotification(message) },
  serverRequest: (_engineId, message) => { void chat.handleServerRequest(message) },
  connection: (_engineId, state) => { chat.setConnection('claude', state.ready, state.processLost ? { processLost: true } : undefined) },
})
if (chatStore) {
  try { chat.recoverInterruptedRuns() }
  catch (error) {
    chatStoreError = publicText(error?.message || 'Local chat recovery failed', 1000)
    console.error('[egdesk-codex-bridge] local chat recovery unavailable:', chatStoreError)
  }
}
// CU-07: the user's Codex MCP servers ordinary threads inherit, by name and
// status only; read once per app-server connection, then kept current by
// startup notices. Bounded QA threads disable them, so their notices are skipped.
const inheritedMcp = createInheritedMcpSync({
  request: (method, params) => appServerRequest(method, params),
  ready: () => appServerReady,
  ignoreThread: threadId => Boolean(threadId && chat.threads.get(threadId)?.executionPolicy),
  onChange: servers => broadcast({ type: 'mcp.inherited', v: BRIDGE_PROTOCOL_VERSION, provider: PROVIDER_ID, inheritedMcp: servers, ts: Date.now() }),
})
const ensureChatAuth = createChatEngineAuth({ chat, refreshCodexAccount: refreshAccountState, getCodexAuth: () => authState })
const handleChatHttp = createChatHttpHandler(chat, ensureChatAuth)
const handleComputerControlHttp = createComputerControlHttpHandler(chat, { port: BRIDGE_PORT })
const handleContextHttp = createContextHttpHandler(contexts, ensureChatAuth, { port: BRIDGE_PORT })
// Like /chat/history, profiles stay editable while Codex is signed out.
const handleProfileHttp = createProfileHttpHandler({ store: () => profileStore, port: BRIDGE_PORT })
// Desk and Board routes also work signed out (local data only).
const handleDeskHttp = createDeskHttpHandler({ store: () => deskStore, port: BRIDGE_PORT })
// RT-03 .egdesk export/inspect/import over the same local stores (signed out too).
// Exports go to ~/Downloads/EG-Desk, or <app data>/exports without a Downloads folder.
const handlePortableHttp = createPortableHttpHandler({ desk: () => deskStore, chat: () => chatStore, profiles: () => profileStore, appDataDir: dataDir, port: BRIDGE_PORT })
// Task graph (CHAT-06): /tasks/*, /task-sources; events (RT-06): /events/browser,
// /events/recent; SSE workflow.event and task.graph frames on /events.
workflow = await openWorkflowRuntime({
  dataDir, chat, port: BRIDGE_PORT, broadcast: event => broadcast(event),
  ensureAuth: () => ensureChatAuth(), getOwnerKey: () => publicAuthIdentityKey(authState), maxConcurrency: 2,
})
if (workflow.snapshot().taskError) console.error('[egdesk-codex-bridge] local task storage unavailable:', workflow.snapshot().taskError)
// ChatGPT plan usage of the signed-in identity, refreshed after sign-in and
// after each turn; a failed read leaves rateLimits as it was (null at first).
const rateLimitSync = createRateLimitSync({
  request: (method, params) => appServerRequest(method, params),
  auth: () => authState,
  ready: () => appServerReady,
  update: patch => updateAuthState(patch),
})

function authSnapshot() {
  return {
    ...authState,
    usage: usageDisplay(authState.rateLimits, Date.now()),
  }
}

function updateAuthState(patch, { broadcastStatus = true } = {}) {
  Object.assign(authState, patch, { lastRefresh: Date.now() })
  if (broadcastStatus) {
    emitAuthStatus()
    broadcast({ type: 'auth-status', status: authSnapshot() })
  }
  // auth.changed carries signedIn only; the account key is compared in memory.
  workflow?.observeAuth({ signedIn: authState.isLoggedIn === true, accountKey: modelAccountKey(authState) })
  engineStatus.check()
}

function authStatusTextFor(snapshot) {
  if (snapshot.isLoggedIn) {
    return snapshot.accountEmail
      ? `Logged in as ${snapshot.accountEmail}`
      : snapshot.authMode === 'chatgpt'
        ? 'Logged in with ChatGPT'
        : 'Logged in'
  }
  if (snapshot.loginInProgress) {
    return 'Signing in…'
  }
  return snapshot.requiresOpenaiAuth ? 'Login required' : 'Ready'
}

function resetLoginState() {
  if (loginPollTimer) {
    clearInterval(loginPollTimer)
    loginPollTimer = null
  }
  authState.loginInProgress = false
  authState.authSessionId = null
  authState.authUrl = null
  authState.verificationUrl = null
  authState.userCode = null
  authState.callbackUrl = null
  authState.loginMode = 'browser'
  authState.loginError = null
}

// Sign-in, sign-out and an account switch all change this, including a
// signed-in account without a public identity key.
function modelAccountKey(state) {
  return `${state.isLoggedIn === true}:${publicAuthIdentityKey(state) ?? ''}`
}

function appServerRequest(method, params) {
  if (!appServerReady || !rpc) return Promise.reject(chatError('BRIDGE_OFFLINE', 'Codex app-server is offline', 503))
  return rpc.request(method, params)
}

async function refreshAccountState({ refreshToken = false } = {}) {
  const [authResult, accountResult] = await Promise.all([
    appServerRequest('getAuthStatus', { includeToken: false, refreshToken }),
    appServerRequest('account/read', { refreshToken: false }),
  ])

  const normalized = normalizeNativeAuth(authResult, accountResult)
  const identityChanged = authState.isLoggedIn && (!normalized.isLoggedIn || publicAuthIdentityKey(authState) !== publicAuthIdentityKey(normalized))
  const previousAccount = modelAccountKey(authState)
  if (identityChanged) chat.reset()
  const nextSnapshot = {
    ...authState,
    ...normalized,
    // Usage belongs to one identity; never show the previous account's numbers.
    rateLimits: identityChanged || !normalized.isLoggedIn ? null : authState.rateLimits,
    loginInProgress: normalized.isLoggedIn ? false : authState.loginInProgress,
  }

  updateAuthState({
    ...nextSnapshot,
    statusText: authStatusTextFor(nextSnapshot),
  })
  if (authState.isLoggedIn && (identityChanged || !authState.rateLimits)) void rateLimitSync.refresh({ force: identityChanged })
  // Models belong to one account; never keep the previous account's list.
  if (modelAccountKey(authState) !== previousAccount) void modelCatalog.refresh({ clear: true })
}

function handleAppServerNotification(message) {
  switch (message.method) {
    case 'account/updated':
      updateAuthState({
        authMode: message.params?.authMode ?? null,
        planType: publicPlanType(message.params?.planType) ?? authState.planType,
        statusText: authStatusTextFor({
          ...authState,
          authMode: message.params?.authMode ?? null,
        }),
      })
      void refreshAccountState().catch(() => {})
      return
    case 'account/login/completed': {
      // The browser login cancelled on a switch to code entry ends with its
      // own loginId; it must not end the code sign-in now running.
      if (isStaleLoginFailure(message.params, authState.authSessionId)) return
      if (loginPollTimer) {
        clearInterval(loginPollTimer)
        loginPollTimer = null
      }
      const success = message.params?.success === true
      const error = typeof message.params?.error === 'string' ? publicText(message.params.error, 2000) : null
      const nextSnapshot = {
        ...authState,
        loginInProgress: false,
        loginError: error,
        // A finished login's page link and one-time code are no longer valid.
        authSessionId: null,
        authUrl: null,
        verificationUrl: null,
        userCode: null,
      }
      updateAuthState({
        ...nextSnapshot,
        statusText: success ? authStatusTextFor(nextSnapshot) : (error || 'Login did not complete'),
      }, { broadcastStatus: false })
      if (success) {
        void refreshAccountState({ refreshToken: true }).catch(() => {})
      } else {
        updateAuthState({
          statusText: error || 'Login did not complete',
        })
      }
      broadcast({
        type: 'login-finished',
        success,
        status: authSnapshot(),
      })
      emitAuthLifecycle('finished', { success, error })
      return
    }
    // Returning here is safe: onNotification still passes the message to
    // the native Reader and Chat runtime afterwards.
    case 'account/rateLimits/updated':
      rateLimitSync.notify(message)
      return
    case 'turn/completed':
      void rateLimitSync.refresh({ force: true })
      return
    case 'mcpServer/startupStatus/updated':
      inheritedMcp.notify(message)
      return
  }
}

function startLoginPolling() {
  if (loginPollTimer) clearInterval(loginPollTimer)
  loginPollTimer = setInterval(async () => {
    if (!authState.loginInProgress) {
      clearInterval(loginPollTimer)
      loginPollTimer = null
      return
    }
    try {
      const wasLoggedIn = authState.isLoggedIn
      await refreshAccountState({ refreshToken: true })
      if (!wasLoggedIn && authState.isLoggedIn) {
        resetLoginState()
        updateAuthState({
          isLoggedIn: true,
          authMode: authState.authMode,
          accountId: authState.accountId,
          accountEmail: authState.accountEmail,
          source: authState.source,
          requiresOpenaiAuth: authState.requiresOpenaiAuth,
          statusText: authStatusTextFor({ ...authState, loginInProgress: false }),
        }, { broadcastStatus: false })
        broadcast({
          type: 'login-finished',
          success: true,
          status: authSnapshot(),
        })
        emitAuthLifecycle('finished', { success: true })
      }
    } catch {
      // Keep polling; transient callback timing issues are expected.
    }
  }, 1000)
}

function scheduleAppServerReconnect() {
  if (reconnectTimer || launchConfigBlocked) return
  // 1s, 2s, 4s … up to 30s with jitter; a ready connection starts over at 1s.
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    appServerBackoff.attempting()
    connectToAppServer()
  }, appServerBackoff.next())
}

function spawnAppServer() {
  if (appServerProcess && appServerProcess.exitCode == null && !appServerProcess.killed) return
  if (appServerLaunch.disableMemories) memoryIsolation = { status: 'pending', feature: 'memories' }
  const executable = resolveCodexExecutable()
  nativeCapabilities = inspectNativeCapabilities({ executable })
  const child = spawn(executable, appServerLaunch.args, {
    cwd: process.cwd(),
    env: process.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  appServerProcess = child
  engineStatus.check()
  child.stdout.on('data', chunk => { const text = publicText(chunk.toString(), 4000).trim(); if (text) console.log(text) })
  child.stderr.on('data', chunk => { const text = publicText(chunk.toString(), 4000).trim(); if (text) console.error(text) })
  const lost = () => {
    if (appServerProcess !== child) return
    appServerProcess = null
    appServerReady = false
    rpc?.close(new Error('Local Codex app-server exited'))
    chat.setConnection(false, { processLost: true })
    inheritedMcp.reset()
    modelCatalog.reset()
    try { appServerSocket?.close() } catch {}
    updateAuthState({ statusText: 'Codex app-server offline', loginInProgress: false })
    scheduleAppServerReconnect()
  }
  child.on('error', lost)
  child.on('close', lost)
}

async function connectToAppServer() {
  if (appServerSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(appServerSocket.readyState)) return
  try { spawnAppServer() } catch (error) {
    updateAuthState({ statusText: publicText(error.message, 1000) })
    scheduleAppServerReconnect()
    return
  }
  let socket
  try { socket = new WebSocket(APP_SERVER_WS_URL) } catch {
    scheduleAppServerReconnect()
    return
  }
  appServerSocket = socket
  const connection = new AppServerRpc({
    send: payload => socket.send(payload),
    experimentalApi: true,
    onNotification: message => {
      handleAppServerNotification(message)
      if (!nativeReader.handleNotification(message)) void chat.handleNotification(message)
    },
    onRequest: message => { if (!nativeReader.handleServerRequest(message)) void chat.handleServerRequest(message) },
  })
  rpc = connection
  socket.onopen = async () => {
    try {
      await connection.initialize()
      if (appServerSocket !== socket) return
      const preflight = await preflightOwnedAppServer({
        launch: appServerLaunch, cwd: process.cwd(),
        request: (method, params) => connection.request(method, params),
        isCurrent: () => appServerSocket === socket,
        stopOwnedChild: () => {
          // Only this bridge's spawned child may be stopped; never signal a
          // user daemon or another App Server merely sharing the endpoint.
          // Fence reconnect before SIGTERM can trigger the child's exit event.
          launchConfigBlocked = true
          appServerReady = false
          if (appServerProcess && appServerProcess.exitCode == null && !appServerProcess.killed) appServerProcess.kill('SIGTERM')
        },
      })
      if (preflight.stale) return
      if (preflight.modelProof) nativePreflight = preflight.modelProof
      if (preflight.memoryProof) memoryIsolation = preflight.memoryProof
      if (!preflight.ready) {
        launchConfigBlocked = preflight.reconnectBlocked
        if (preflight.failedStage === 'model') nativePreflight = { ...nativePreflight, status: 'blocked', effectiveModel: null, effectiveEffort: null, errorCode: preflight.error.code || 'CODEX_LAUNCH_CONFIG_UNVERIFIED' }
        if (appServerLaunch.disableMemories) memoryIsolation = { status: 'blocked', feature: 'memories', errorCode: preflight.error.code || 'CODEX_MEMORY_ISOLATION_UNVERIFIED' }
        throw preflight.error
      }
      appServerReady = true
      appServerBackoff.reset()
      chat.setConnection(true)
      void inheritedMcp.refresh()
      await refreshAccountState()
      void modelCatalog.refresh()
    } catch (error) {
      console.error('[egdesk-codex-bridge] initialization failed:', publicText(error.message, 1000))
      socket.close()
    }
  }
  socket.onmessage = event => {
    if (appServerSocket === socket) connection.receive(event.data.toString())
  }
  socket.onerror = () => {
    if (appServerSocket !== socket) return
    appServerReady = false
    chat.setConnection(false)
    engineStatus.check()
  }
  socket.onclose = () => {
    connection.close()
    if (appServerSocket !== socket) return
    appServerSocket = null
    appServerReady = false
    if (!launchConfigBlocked && appServerLaunch.hasOverrides) nativePreflight = { ...nativePreflight, status: 'pending', effectiveModel: null, effectiveEffort: null }
    if (rpc === connection) rpc = null
    chat.setConnection(false)
    inheritedMcp.reset()
    modelCatalog.reset()
    engineStatus.check()
    if (appServerLaunch.disableMemories && !launchConfigBlocked) memoryIsolation = { status: 'pending', feature: 'memories' }
    scheduleAppServerReconnect()
  }
}

async function startChatgptLogin() {
  const result = await appServerRequest('account/login/start', { type: 'chatgpt' })
  if (!result || result.type !== 'chatgpt') {
    throw new Error('Unexpected login response')
  }
  updateAuthState({
    loginInProgress: true,
    authSessionId: result.loginId,
    authUrl: result.authUrl,
    verificationUrl: null,
    userCode: null,
    callbackUrl: null,
    loginMode: 'browser',
    statusText: 'Signing in…',
  }, { broadcastStatus: false })
  startLoginPolling()
  broadcast({ type: 'login-started' })
  emitAuthLifecycle('started', { loginId: result.loginId, mode: 'browser' })
  emitAuthStatus()
  broadcast({ type: 'auth-status', status: authSnapshot() })
  return result
}

// SUB-04 code entry: the screen shows verificationUrl and userCode; the user
// signs in there and types the code, so no browser callback is needed. The
// code reaches the screen only (auth status and this answer), never a log.
async function startChatgptDeviceLogin() {
  const result = await appServerRequest('account/login/start', codexLoginStartParams('device'))
  let patch
  try { patch = codexDeviceLoginPatch(result) }
  catch (error) {
    // An incomplete answer must not leave a half-started login behind.
    if (typeof result?.loginId === 'string') void appServerRequest('account/login/cancel', { loginId: result.loginId }).catch(() => {})
    throw error
  }
  updateAuthState(patch, { broadcastStatus: false })
  startLoginPolling()
  broadcast({ type: 'login-started' })
  emitAuthLifecycle('started', { loginId: patch.authSessionId, mode: 'device' })
  emitAuthStatus()
  broadcast({ type: 'auth-status', status: authSnapshot() })
  return patch
}

// ── Terminal PTY support ──
const terminalRegistry = new TerminalSessionRegistry({ onExit: receipt => workflow?.publishTerminalExit(receipt) })

// npm 설치 과정에서 node-pty spawn-helper의 실행 비트가 소실되는 경우가 있어
// (posix_spawnp failed → 조용히 child_process fallback 강등) 기동 시 복구한다.
try {
  const { chmodSync, readdirSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const prebuilds = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules', 'node-pty', 'prebuilds')
  for (const dir of readdirSync(prebuilds)) {
    if (!dir.startsWith('darwin')) continue
    try { chmodSync(path.join(prebuilds, dir, 'spawn-helper'), 0o755) } catch {}
  }
} catch {}

const terminalFactory = createTerminalSessionFactory({ registry: terminalRegistry })
const handleTerminalHttp = createTerminalHttpHandler({ registry: terminalRegistry, factory: terminalFactory, port: BRIDGE_PORT })

const bridgeServer = createServer(async (req, res) => {
  if (!req.url) {
    sendJson(res, 404, { error: 'Not found' })
    return
  }

  if (!guardBridgeRequest(req, BRIDGE_PORT)) {
    sendJson(res, 403, { error: 'Loopback origin required' })
    return
  }
  setBridgeCors(req, res)
  let url
  try { url = new URL(req.url, `http://127.0.0.1:${BRIDGE_PORT}`) } catch {
    sendJson(res, 400, { error: 'Invalid request URL' })
    return
  }
  const route = url.pathname

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Headers': 'Content-Type, X-EGDesk-Overlay-Build',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS'
    })
    res.end()
    return
  }

  // File routes have their own bounded 18 MiB draft reader and local owner.
  // Dispatch before any generic body reader or Codex/account authentication.
  if (await localFiles.handle(req, res, url)) return

  if (req.method === 'GET' && route === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    let browserTransportId = null
    const client = new BoundedSseClient(res, {
      chatProtocol: url.searchParams.get('chatProtocol') === '2' ? 2 : 1,
      onClose: () => { clients.delete(client); if (browserTransportId) browserTransport.closeClient(browserTransportId) },
    })
    clients.add(client)
    if (client.chatProtocol === 2) browserTransportId = browserTransport.registerClient(client)
    client.send(`retry: 1000\nevent: ready\ndata: ${JSON.stringify({ ok: true, streamId: chat.streamId, seq: chat.seq, resyncRequired: true, ...(browserTransportId ? { browserTransportId } : {}) })}\n\n`)
    return
  }

  // Workflow events and task graph routes have their own loopback/Origin guard.
  if (await workflow.handle(req, res, url)) return

  if (req.method === 'POST' && route === '/browser-tool/respond') {
    try {
      const body = await readJsonBody(req, { maxBytes: 190000 })
      sendJson(res, 200, browserTransport.receive(body.browserTransportId, body.response))
    } catch (error) {
      const failure = classifyPublicToolError(error, { browser: true })
      sendJson(res, error.httpStatus || 409, { accepted: false, code: failure.code, error: failure.message })
    }
    return
  }

  if (req.method === 'GET' && route === '/health') {
    sendJson(res, 200, { ok: true, port: BRIDGE_PORT, appServerReady, chatStorageReady: Boolean(chatStore && chat.storeHealthy), chatStorageError: chatStoreError, profileStorageReady: Boolean(profileStore), profileStorageError: profileStoreError, deskStorageReady: Boolean(deskStore), deskStorageError: deskStoreError, native: nativeCapabilities, engineConfiguration: nativePreflight, memoryIsolation, node: nodeRuntime })
    return
  }

  if (req.method === 'GET' && route === '/system/resources') {
    try {
      // The bridge's loopback/Origin/Fetch Metadata guard above is the local
      // caller boundary. Host metrics must work before any AI account login.
      sendJson(res, 200, await systemResourceMonitor.sample())
    } catch (error) {
      sendJson(res, 503, { code: 'RESOURCE_MONITOR_UNAVAILABLE', error: 'System resource monitor unavailable' })
    }
    return
  }

  if (req.method === 'GET' && route === '/v1/state') {
    try {
      await refreshAccountState()
    } catch {}
    // At most once a minute, in the background; a change arrives as engine.status.
    void claudeEngineStatus.refresh()
    sendJson(res, 200, {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      provider: PROVIDER_ID,
      appServerReady,
      chatStorageReady: Boolean(chatStore && chat.storeHealthy),
      profileStorageReady: Boolean(profileStore),
      native: nativeCapabilities,
      engineConfiguration: nativePreflight,
      memoryIsolation,
      node: nodeRuntime,
      auth: authSnapshot(),
      chat: chat.snapshot(),
      capabilities: {
        auth: ['status', 'start', 'cancel', 'signout', 'usage', 'device-code'],
        chat: chatStore && chat.storeHealthy ? ['send', 'stream', 'resume', 'interrupt', 'approvals', 'user-input', 'subagent-status', 'typed-activity', 'artifact-refs', 'local-history', 'legacy-import', 'stateless', 'fork', ...(nativeCapabilities.qaReadOnly ? ['read-only-qa'] : [])] : ['local-history-unavailable'],
        context: nativeCapabilities.schemaMatch ? ['capture', 'immutable-inspect', 'native-dynamic-tools', 'smart-read', 'read-only-reader', 'answer-briefing'] : ['capture', 'immutable-inspect'],
        files: ['native-picker', 'scoped-read', 'managed-drafts', 'create-only-save-as'],
        profiles: profileStore ? ['local-store', 'revisions', 'run-binding'] : ['local-store-unavailable'],
        engines: ['registry', 'thread-lock'],
        desk: deskStore ? ['local-store', 'generations', 'restore', 'board-revisions', 'board-revert', 'prefs-import'] : ['local-store-unavailable'],
        portable: deskStore ? ['export', 'inspect', 'import-as-new', 'passphrase', 'exports-list'] : ['local-store-unavailable'],
      },
      bridge: bridgeBuildState(bridgeBuild, expectedOverlayBuild(req.headers, url.searchParams)),
      appServerReconnect: appServerBackoff.snapshot(),
      // Settings 'Accounts & AI engines' rows; the top-level Codex fields stay for older overlays.
      engines: engineRegistry.publicEngines(),
      // CU-07 rows { name, enabled, status, controlsExternal, kind }, or null when unknown.
      inheritedMcp: inheritedMcp.snapshot(),
      // RT-06/CHAT-06 { tasks, taskError, maxConcurrency, eventSeq, droppedEvents, watchedRoots, maxWatchedRoots, refusedRoots, droppedFileEvents }.
      workflow: workflow.snapshot(),
      // CU-01 { policy: 'inherit'|'off', verified: true|false|null, persisted: boolean } for ordinary Codex threads.
      computerControl: chat.computerControlSnapshot(),
      // RT-07 Desk store ready; false means the screen keeps its preference values.
      deskStorageReady: Boolean(deskStore),
    })
    return
  }

  if (req.method === 'GET' && route === '/auth/status') {
    try {
      await refreshAccountState()
    } catch {}
    sendJson(res, 200, authSnapshot())
    return
  }

  if (req.method === 'POST' && route === '/auth/start') {
    try {
      // { mode: 'device' } starts code entry (SUB-04); no body keeps the browser flow.
      const body = await readJsonBody(req, { maxBytes: 1024 })
      const mode = codexLoginMode(body.mode)
      await refreshAccountState()
      if (authState.isLoggedIn) {
        sendJson(res, 200, {
          started: false,
          alreadyLoggedIn: true,
          message: authState.statusText,
        })
        return
      }
      if (authState.loginInProgress && authState.authSessionId) {
        if (authState.loginMode === mode) {
          sendJson(res, 200, codexLoginInProgressResponse(authState))
          return
        }
        // Switching between browser and code entry ends the running login first.
        try { await appServerRequest('account/login/cancel', { loginId: authState.authSessionId }) } catch {}
        resetLoginState()
      }
      if (mode === 'device') {
        const patch = await startChatgptDeviceLogin()
        sendJson(res, 200, { started: true, mode, loginId: patch.authSessionId, verificationUrl: patch.verificationUrl, userCode: patch.userCode })
        return
      }
      const result = await startChatgptLogin()
      sendJson(res, 200, {
        started: true,
        mode,
        loginId: result.loginId,
        authUrl: result.authUrl,
      })
    } catch (error) {
      const message = publicText(error instanceof Error ? error.message : String(error), 2000)
      // A malformed request (body, mode) is the caller's error, not a failed login.
      if (Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus < 500) {
        sendJson(res, error.httpStatus, { started: false, code: error.code || 'INVALID_REQUEST', message })
        return
      }
      emitAuthLifecycle('failed', { error: message })
      sendJson(res, 500, {
        started: false,
        message,
      })
    }
    return
  }

  // 'Check again' for the Claude row (e.g. after `claude auth login` in a
  // terminal): one static check, coalesced, then the public row.
  if (req.method === 'POST' && route === '/engines/claude/refresh') {
    await claudeEngineStatus.refresh({ force: true })
    sendJson(res, 200, { engine: engineRegistry.publicEngines().find(row => row.id === 'claude') ?? null })
    return
  }

  // D-S1 login button: the line a Terminal card runs (`claude auth login
  // --claudeai|--console`). The CLI keeps the credential; EG-Desk never sees it.
  if (req.method === 'GET' && route === '/engines/claude/login-command') {
    try {
      sendJson(res, 200, claudeLoginTerminalCommand(url.searchParams.get('method') ?? undefined))
    } catch (error) {
      sendJson(res, error.httpStatus || 400, { code: error.code || 'CLAUDE_LOGIN_METHOD_INVALID', error: publicText(error.message, 300) })
    }
    return
  }

  // D-S4: an Anthropic API key in EG-Desk's environment stops Claude starts
  // until the user confirms running on the subscription without it. Names
  // only, never values; the confirmation lasts for this helper run.
  if (route === '/engines/claude/api-key-env' && (req.method === 'GET' || req.method === 'POST')) {
    try {
      if (req.method === 'POST') {
        const body = await readJsonBody(req, { maxBytes: 1024 })
        if (typeof body.confirm !== 'boolean') throw chatError('INVALID_CONFIRMATION', 'confirm must be true or false', 400)
        claudeEngine.confirmApiKeyEnv(body.confirm)
      }
      sendJson(res, 200, { ...claudeEngine.apiKeyEnv(), engine: engineRegistry.publicEngines().find(row => row.id === 'claude') ?? null })
    } catch (error) {
      sendJson(res, error.httpStatus || 400, { code: error.code || 'INVALID_REQUEST', error: publicText(error.message, 300) })
    }
    return
  }

  if (req.method === 'POST' && route === '/auth/cancel') {
    try {
      if (!authState.authSessionId) {
        sendJson(res, 200, { status: 'notFound' })
        return
      }
      const result = await appServerRequest('account/login/cancel', { loginId: authState.authSessionId })
      resetLoginState()
      updateAuthState({ statusText: 'Login cancelled' })
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, { error: publicText(error instanceof Error ? error.message : String(error), 2000) })
    }
    return
  }

  if (req.method === 'POST' && route === '/auth/signout') {
    try {
      await appServerRequest('account/logout', undefined)
      chat.reset()
      resetLoginState()
      await refreshAccountState()
      sendJson(res, 200, authSnapshot())
    } catch (error) {
      sendJson(res, 500, { error: publicText(error instanceof Error ? error.message : String(error), 2000) })
    }
    return
  }

  if (await handleComputerControlHttp(req, res, url)) return
  if (await handleProfileHttp(req, res, url)) return
  if (await handleDeskHttp(req, res, url)) return
  if (await handlePortableHttp(req, res, url)) return
  if (await handleContextHttp(req, res, url)) return
  if (await handleChatHttp(req, res, url)) return

  // ── Terminal endpoints ──
  if (await handleTerminalHttp(req, res, url)) return
  sendJson(res, 404, { error: 'Not found' })
})

bridgeServer.on('error', (error) => {
  if (error?.code === 'EADDRINUSE') {
    // 이미 다른 브리지가 떠 있음 — 자동 기동(런처)과의 이중 실행은 정상 시나리오
    console.error(`[egdesk-codex-bridge] port ${BRIDGE_PORT} already in use — another bridge is running. Exiting.`)
    process.exit(0)
  }
  console.error('[egdesk-codex-bridge] server error:', error)
  process.exit(1)
})

bridgeServer.listen(BRIDGE_PORT, '127.0.0.1', () => {
  console.log(`[egdesk-codex-bridge] listening on http://127.0.0.1:${BRIDGE_PORT}`)
  console.log(`[egdesk-codex-bridge] Node.js ${nodeRuntime.version}; requires ${nodeRuntime.minimumVersion}+, integration baseline ${nodeRuntime.integrationBaseline}; node:sqlite available`)
  broadcast({
    type: 'bridge.ready',
    v: BRIDGE_PROTOCOL_VERSION,
    provider: PROVIDER_ID,
    ts: Date.now(),
  })
  void connectToAppServer()
  void claudeEngineStatus.refresh()
})

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  bridgeServer.close()
  systemResourceMonitor.close()
  try { await claudeEngine.dispose() }
  catch { console.error('[egdesk-codex-bridge] Claude conversations did not close cleanly') }
  try { await workflow?.close() }
  catch { console.error('[egdesk-codex-bridge] workflow runtime did not close cleanly') }
  try { await localFiles.close() }
  catch { console.error('[egdesk-codex-bridge] managed file store did not close cleanly') }
  try { chatStore?.close() }
  catch { console.error('[egdesk-codex-bridge] local chat store did not close cleanly') }
  try { profileStore?.close() }
  catch { console.error('[egdesk-codex-bridge] local profile store did not close cleanly') }
  try { deskStore?.close() }
  catch { console.error('[egdesk-codex-bridge] local Desk store did not close cleanly') }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', () => {
  systemResourceMonitor.close()
  workflow?.files.close()
  rpc?.close()
  try { appServerSocket?.close(); } catch {}
  try { appServerProcess?.kill(); } catch {}
  terminalRegistry.requestStopAll()
})
