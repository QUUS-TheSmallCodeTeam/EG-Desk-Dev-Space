import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { AppServerRpc } from './codex-app-server-rpc.mjs'
import { normalizeNativeAuth, publicAuthIdentityKey } from './codex-auth-state.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { BrowserToolTransport } from './codex-browser-tool-transport.mjs'
import { createCodexBrowserToolProvider } from './codex-browser-tool-provider.mjs'
import { fixtureBrowserQaFromEnv } from './codex-browser-fixture-qa.mjs'
import { classifyPublicToolError } from './codex-tool-errors.mjs'
import { createChatHttpHandler, guardBridgeRequest, readJsonBody, sendJson, setBridgeCors } from './codex-bridge-http.mjs'
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
import { NativeReaderClient } from './egdesk-native-reader.mjs'
import { ContextRuntime } from './egdesk-context-runtime.mjs'
import { createContextHttpHandler } from './egdesk-context-http.mjs'
import { buildCodexAppServerLaunch, inspectNativeCapabilities, preflightOwnedAppServer, resolveCodexExecutable, NATIVE_SCHEMA_VERSION } from './egdesk-native-capabilities.mjs'
import { createEGDeskFileMount, requireEGDeskNodeRuntime } from './egdesk-file-mount.mjs'

const nodeRuntime = requireEGDeskNodeRuntime()

const BRIDGE_PORT = 39218
const APP_SERVER_PORT = 39219
const APP_SERVER_WS_URL = `ws://127.0.0.1:${APP_SERVER_PORT}`
const appServerLaunch = buildCodexAppServerLaunch({ env: process.env, listen: APP_SERVER_WS_URL })
const BRIDGE_PROTOCOL_VERSION = 1
const PROVIDER_ID = 'codex'

const clients = new Set()

let appServerProcess = null
let appServerSocket = null
let appServerReady = false
let reconnectTimer = null
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
let chatStore = null
let chatStoreError = null
try {
  chatStore = openChatStore({ dataDir: path.join(dataDir, 'chat'), ownerScope: 'local-desktop-v1' })
} catch (error) {
  chatStoreError = publicText(error?.message || 'Local chat storage failed to open', 1000)
  console.error('[egdesk-codex-bridge] local chat storage unavailable:', chatStoreError)
}
const localFiles = createEGDeskFileMount({ dataDir, port: BRIDGE_PORT })
const contextStore = new ImmutableContextStore({
  dataDir,
  managedFileView: localFiles.managedFileView,
  allowedRoots: process.env.EGDESK_CONTEXT_ROOTS ? process.env.EGDESK_CONTEXT_ROOTS.split(path.delimiter).filter(Boolean) : [process.cwd()],
})
const nativeReader = new NativeReaderClient({ request: (method, params) => appServerRequest(method, params), respond: nativeRespond, getOwnerKey: () => publicAuthIdentityKey(authState) })
const contexts = new ContextRuntime({ store: contextStore, reader: nativeReader, getOwnerKey: () => publicAuthIdentityKey(authState), schemaReady: () => nativeCapabilities.schemaMatch && appServerReady })
const browserTransport = new BrowserToolTransport({ getOwnerKey: () => publicAuthIdentityKey(authState) })
const browserProvider = createCodexBrowserToolProvider({ transport: browserTransport, getOwnerKey: () => publicAuthIdentityKey(authState), schemaReady: () => nativeCapabilities.qaReadOnly && appServerReady, fixtureQa: fixtureBrowserQaFromEnv(process.env) })
const chat = new CodexChatRuntime({
  request: (method, params) => appServerRequest(method, params),
  respond: nativeRespond,
  contexts,
  toolProviders: [browserProvider],
  store: chatStore,
  requireStore: true,
  getOwnerKey: () => publicAuthIdentityKey(authState),
  expectedProcessConfiguration: { model: appServerLaunch.configuredModel, effort: appServerLaunch.configuredEffort },
  qaReady: () => nativeCapabilities.qaReadOnly && appServerReady,
  getNativeContractFingerprint: () => nativeCapabilities.contractFingerprint,
  emit: event => broadcast(event, 2),
  emitLegacy: event => broadcast(event, 1),
})
if (chatStore) {
  try { chat.recoverInterruptedRuns() }
  catch (error) {
    chatStoreError = publicText(error?.message || 'Local chat recovery failed', 1000)
    console.error('[egdesk-codex-bridge] local chat recovery unavailable:', chatStoreError)
  }
}
const ensureChatAuth = async () => {
  chat.assertReady()
  await refreshAccountState()
  if (!authState.isLoggedIn) throw chatError('LOGIN_REQUIRED', 'Codex ChatGPT login is required', 401)
}
const handleChatHttp = createChatHttpHandler(chat, ensureChatAuth)
const handleContextHttp = createContextHttpHandler(contexts, ensureChatAuth)

function authSnapshot() {
  return {
    ...authState,
  }
}

function updateAuthState(patch, { broadcastStatus = true } = {}) {
  Object.assign(authState, patch, { lastRefresh: Date.now() })
  if (broadcastStatus) {
    emitAuthStatus()
    broadcast({ type: 'auth-status', status: authSnapshot() })
  }
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
  if (authState.isLoggedIn && (!normalized.isLoggedIn || publicAuthIdentityKey(authState) !== publicAuthIdentityKey(normalized))) chat.reset()
  const nextSnapshot = {
    ...authState,
    ...normalized,
    loginInProgress: normalized.isLoggedIn ? false : authState.loginInProgress,
  }

  updateAuthState({
    ...nextSnapshot,
    statusText: authStatusTextFor(nextSnapshot),
  })
}

function handleAppServerNotification(message) {
  switch (message.method) {
    case 'account/updated':
      updateAuthState({
        authMode: message.params?.authMode ?? null,
        statusText: authStatusTextFor({
          ...authState,
          authMode: message.params?.authMode ?? null,
        }),
      })
      void refreshAccountState().catch(() => {})
      return
    case 'account/login/completed': {
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
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectToAppServer()
  }, 1000)
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
  child.stdout.on('data', chunk => { const text = publicText(chunk.toString(), 4000).trim(); if (text) console.log(text) })
  child.stderr.on('data', chunk => { const text = publicText(chunk.toString(), 4000).trim(); if (text) console.error(text) })
  const lost = () => {
    if (appServerProcess !== child) return
    appServerProcess = null
    appServerReady = false
    rpc?.close(new Error('Local Codex app-server exited'))
    chat.setConnection(false, { processLost: true })
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
      chat.setConnection(true)
      await refreshAccountState()
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
  }
  socket.onclose = () => {
    connection.close()
    if (appServerSocket !== socket) return
    appServerSocket = null
    appServerReady = false
    if (!launchConfigBlocked && appServerLaunch.hasOverrides) nativePreflight = { ...nativePreflight, status: 'pending', effectiveModel: null, effectiveEffort: null }
    if (rpc === connection) rpc = null
    chat.setConnection(false)
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

// ── Terminal PTY support ──
const terminalRegistry = new TerminalSessionRegistry()

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
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
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
    sendJson(res, 200, { ok: true, port: BRIDGE_PORT, appServerReady, chatStorageReady: Boolean(chatStore && chat.storeHealthy), chatStorageError: chatStoreError, native: nativeCapabilities, engineConfiguration: nativePreflight, memoryIsolation, node: nodeRuntime })
    return
  }

  if (req.method === 'GET' && route === '/v1/state') {
    try {
      await refreshAccountState()
    } catch {}
    sendJson(res, 200, {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      provider: PROVIDER_ID,
      appServerReady,
      chatStorageReady: Boolean(chatStore && chat.storeHealthy),
      native: nativeCapabilities,
      engineConfiguration: nativePreflight,
      memoryIsolation,
      node: nodeRuntime,
      auth: authSnapshot(),
      chat: chat.snapshot(),
      capabilities: {
        auth: ['status', 'start', 'cancel', 'signout'],
        chat: chatStore && chat.storeHealthy ? ['send', 'stream', 'resume', 'interrupt', 'approvals', 'typed-activity', 'artifact-refs', 'local-history', 'legacy-import', ...(nativeCapabilities.qaReadOnly ? ['read-only-qa'] : [])] : ['local-history-unavailable'],
        context: nativeCapabilities.schemaMatch ? ['capture', 'immutable-inspect', 'native-dynamic-tools', 'smart-read', 'read-only-reader', 'answer-briefing'] : ['capture', 'immutable-inspect'],
        files: ['native-picker', 'scoped-read', 'managed-drafts', 'create-only-save-as'],
      },
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
        sendJson(res, 200, {
          started: false,
          loginInProgress: true,
          loginId: authState.authSessionId,
          message: 'Codex browser login is already running.'
        })
        return
      }
      const result = await startChatgptLogin()
      sendJson(res, 200, {
        started: true,
        loginId: result.loginId,
        authUrl: result.authUrl,
      })
    } catch (error) {
      emitAuthLifecycle('failed', { error: publicText(error instanceof Error ? error.message : String(error), 2000) })
      sendJson(res, 500, {
        started: false,
        message: publicText(error instanceof Error ? error.message : String(error), 2000),
      })
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
})

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  bridgeServer.close()
  try { await localFiles.close() }
  catch { console.error('[egdesk-codex-bridge] managed file store did not close cleanly') }
  try { chatStore?.close() }
  catch { console.error('[egdesk-codex-bridge] local chat store did not close cleanly') }
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.on('exit', () => {
  rpc?.close()
  try { appServerSocket?.close(); } catch {}
  try { appServerProcess?.kill(); } catch {}
  terminalRegistry.requestStopAll()
})
