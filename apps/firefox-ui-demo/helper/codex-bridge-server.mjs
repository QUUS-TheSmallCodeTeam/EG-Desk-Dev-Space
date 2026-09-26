import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { AppServerRpc } from './codex-app-server-rpc.mjs'
import { CodexChatRuntime } from './codex-chat-runtime.mjs'
import { createChatHttpHandler, guardBridgeRequest, readJsonBody, sendJson, setBridgeCors } from './codex-bridge-http.mjs'
import { chatError, publicText } from './codex-chat-values.mjs'
import { randomBytes } from 'node:crypto'
import * as os from 'node:os'

const BRIDGE_PORT = 39218
const APP_SERVER_PORT = 39219
const APP_SERVER_WS_URL = `ws://127.0.0.1:${APP_SERVER_PORT}`
const BRIDGE_PROTOCOL_VERSION = 1
const PROVIDER_ID = 'codex'

const clients = new Set()

let appServerProcess = null
let appServerSocket = null
let appServerReady = false
let reconnectTimer = null
let loginPollTimer = null
let rpc = null

const authState = {
  isLoggedIn: false,
  authMode: null,
  accountId: null,
  accountEmail: null,
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
  for (const res of clients) {
    if (chatProtocol && res.chatProtocol !== chatProtocol) continue
    try {
      if (!res.write(payload)) {
        clients.delete(res)
        res.destroy()
      }
    } catch {
      clients.delete(res)
    }
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

const chat = new CodexChatRuntime({
  request: (method, params) => appServerRequest(method, params),
  respond: (id, result, error) => {
    if (!rpc) throw chatError('BRIDGE_OFFLINE', 'Codex app-server is offline', 503)
    rpc.respond(id, result, error)
  },
  emit: event => broadcast(event, 2),
  emitLegacy: event => broadcast(event, 1),
})
const handleChatHttp = createChatHttpHandler(chat, async () => {
  chat.assertReady()
  await refreshAccountState()
  if (!authState.isLoggedIn) throw chatError('LOGIN_REQUIRED', 'Codex ChatGPT login is required', 401)
})

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

  const account = accountResult?.account ?? null
  const isLoggedIn = authResult?.authMethod === 'chatgpt' || account?.type === 'chatgpt'
  if (authState.isLoggedIn && (!isLoggedIn || authState.accountEmail !== (account?.email ?? null))) chat.reset()
  const nextSnapshot = {
    ...authState,
    isLoggedIn,
    loginInProgress: isLoggedIn ? false : authState.loginInProgress,
    authMode: authResult?.authMethod ?? null,
    accountId: account?.type === 'chatgpt' ? 'chatgpt' : null,
    accountEmail: account?.type === 'chatgpt' ? account.email ?? null : null,
    source: 'app-server',
    requiresOpenaiAuth: authResult?.requiresOpenaiAuth ?? true,
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
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectToAppServer()
  }, 1000)
}

function spawnAppServer() {
  if (appServerProcess && appServerProcess.exitCode == null && !appServerProcess.killed) return
  const child = spawn(process.env.EGDESK_CODEX_BIN || 'codex', ['app-server', '--listen', APP_SERVER_WS_URL], {
    cwd: process.cwd(),
    env: process.env,
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
  spawnAppServer()
  let socket
  try { socket = new WebSocket(APP_SERVER_WS_URL) } catch {
    scheduleAppServerReconnect()
    return
  }
  appServerSocket = socket
  const connection = new AppServerRpc({
    send: payload => socket.send(payload),
    onNotification: message => {
      handleAppServerNotification(message)
      void chat.handleNotification(message)
    },
    onRequest: message => { void chat.handleServerRequest(message) },
  })
  rpc = connection
  socket.onopen = async () => {
    try {
      await connection.initialize()
      if (appServerSocket !== socket) return
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
    if (rpc === connection) rpc = null
    chat.setConnection(false)
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
const terminalSessions = new Map()

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

async function createTerminalSession(cols = 80, rows = 24, shell = null) {
  const sessionId = `term-${randomBytes(6).toString('hex')}`
  const defaultShell = shell || process.env.SHELL || (os.platform() === 'darwin' ? '/bin/zsh' : '/bin/bash')

  // 브리지가 GUI/백그라운드에서 뜨면 LANG/LC_*가 비어 PTY가 C 로케일이 된다 —
  // zsh ZLE가 한글 등 멀티바이트 입력을 <0084> 식 바이트 조각으로 렌더링.
  // UTF-8 로케일을 보장한다 (기존 UTF-8 설정은 존중).
  const isUtf8 = (v) => typeof v === 'string' && /utf-?8/i.test(v)
  const localeEnv = {
    LANG: isUtf8(process.env.LANG) ? process.env.LANG : 'ko_KR.UTF-8',
    LC_CTYPE: isUtf8(process.env.LC_CTYPE) ? process.env.LC_CTYPE
      : (isUtf8(process.env.LANG) ? process.env.LANG : 'ko_KR.UTF-8'),
  }

  let ptyProcess = null
  let usePty = false

  try {
    const nodePty = await import('node-pty')
    ptyProcess = nodePty.default.spawn(defaultShell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: os.homedir(),
      env: {
        ...process.env,
        ...localeEnv,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    })
    usePty = true
  } catch (e) {
    // Fallback: use child_process — 프롬프트/에코 없는 강등 모드이므로 반드시 원인 로깅
    console.warn(`[terminal] node-pty not available, using child_process fallback: ${e?.message || e}`)
    ptyProcess = spawn(defaultShell, [], {
      cwd: os.homedir(),
      env: {
        ...process.env,
        ...localeEnv,
        TERM: 'dumb',
        COLUMNS: String(cols),
        LINES: String(rows),
        ZDOTDIR: '/tmp/egdesk-zsh',
        PS1: '\\n$ ',
        PROMPT: '\\n$ ',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    })
  }

  const outputBuffer = []
  let exited = false
  let exitCode = null

  if (usePty) {
    ptyProcess.onData((data) => { outputBuffer.push(data) })
    ptyProcess.onExit(({ exitCode: code }) => { exited = true; exitCode = code })
  } else {
    ptyProcess.stdout.on('data', (data) => { outputBuffer.push(data.toString()) })
    ptyProcess.stderr.on('data', (data) => { outputBuffer.push(data.toString()) })
    ptyProcess.on('exit', (code) => { exited = true; exitCode = code })
    ptyProcess.on('error', (err) => { outputBuffer.push(`\r\nError: ${err.message}\r\n`); exited = true })
  }

  const session = {
    id: sessionId,
    process: ptyProcess,
    usePty,
    outputBuffer,
    exited: () => exited,
    exitCode: () => exitCode,
    shell: defaultShell,
    cols,
    rows,
    createdAt: Date.now(),
  }
  terminalSessions.set(sessionId, session)
  return session
}

function writeToTerminal(sessionId, data) {
  const session = terminalSessions.get(sessionId)
  if (!session) return { error: 'Session not found' }
  if (session.exited()) return { error: 'Session has exited' }
  const proc = session.process
  if (session.usePty) { proc.write(data) }
  else if (proc.stdin) { proc.stdin.write(data) }
  return { ok: true }
}

function readFromTerminal(sessionId) {
  const session = terminalSessions.get(sessionId)
  if (!session) return { error: 'Session not found', data: '', exited: true }
  const data = session.outputBuffer.splice(0).join('')
  return { data, exited: session.exited(), exitCode: session.exitCode() }
}

function resizeTerminal(sessionId, cols, rows) {
  const session = terminalSessions.get(sessionId)
  if (!session) return { error: 'Session not found' }
  if (session.exited()) return { error: 'Session has exited' }
  session.cols = cols
  session.rows = rows
  if (session.usePty && session.process.resize) { session.process.resize(cols, rows) }
  return { ok: true }
}

function killTerminal(sessionId) {
  const session = terminalSessions.get(sessionId)
  if (!session) return { error: 'Session not found' }
  try {
    if (session.process.kill) session.process.kill()
    else if (session.process.destroy) session.process.destroy()
  } catch (e) { /* ignore */ }
  terminalSessions.delete(sessionId)
  return { ok: true }
}

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

  if (req.method === 'GET' && route === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    res.write('event: ready\ndata: {"ok":true}\n\n')
    res.chatProtocol = url.searchParams.get('chatProtocol') === '2' ? 2 : 1
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  if (req.method === 'GET' && route === '/health') {
    sendJson(res, 200, { ok: true, port: BRIDGE_PORT, appServerReady })
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
      auth: authSnapshot(),
      chat: chat.snapshot(),
      capabilities: {
        auth: ['status', 'start', 'cancel', 'signout'],
        chat: ['send', 'stream', 'resume', 'interrupt', 'approvals', 'typed-activity', 'artifact-refs'],
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

  if (await handleChatHttp(req, res, url)) return

  // ── Terminal endpoints ──
  if (req.method === 'POST' && route === '/terminal/spawn') {
    try {
      const body = await readJsonBody(req)
      const session = await createTerminalSession(body.cols, body.rows, body.shell)
      sendJson(res, 200, { sessionId: session.id, shell: session.shell, cols: session.cols, rows: session.rows })
    } catch (error) {
      sendJson(res, 500, { error: publicText(error instanceof Error ? error.message : String(error), 2000) })
    }
    return
  }
  if (req.method === 'POST' && route === '/terminal/write') {
    try {
      const body = await readJsonBody(req)
      const result = writeToTerminal(body.sessionId, body.data)
      sendJson(res, result.error ? 400 : 200, result)
    } catch (error) {
      sendJson(res, 500, { error: publicText(error instanceof Error ? error.message : String(error), 2000) })
    }
    return
  }
  if (req.method === 'POST' && route === '/terminal/read') {
    try {
      const body = await readJsonBody(req)
      const result = readFromTerminal(body.sessionId)
      sendJson(res, result.error ? 400 : 200, result)
    } catch (error) {
      sendJson(res, 500, { error: publicText(error instanceof Error ? error.message : String(error), 2000) })
    }
    return
  }
  if (req.method === 'POST' && route === '/terminal/resize') {
    try {
      const body = await readJsonBody(req)
      const result = resizeTerminal(body.sessionId, body.cols, body.rows)
      sendJson(res, result.error ? 400 : 200, result)
    } catch (error) {
      sendJson(res, 500, { error: publicText(error instanceof Error ? error.message : String(error), 2000) })
    }
    return
  }
  if (req.method === 'POST' && route === '/terminal/kill') {
    try {
      const body = await readJsonBody(req)
      const result = killTerminal(body.sessionId)
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, { error: publicText(error instanceof Error ? error.message : String(error), 2000) })
    }
    return
  }
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
  broadcast({
    type: 'bridge.ready',
    v: BRIDGE_PROTOCOL_VERSION,
    provider: PROVIDER_ID,
    ts: Date.now(),
  })
  void connectToAppServer()
})

process.on('SIGINT', () => process.exit(0))
process.on('SIGTERM', () => process.exit(0))
process.on('exit', () => {
  rpc?.close()
  try { appServerSocket?.close(); } catch {}
  try { appServerProcess?.kill(); } catch {}
  // Cleanup terminal sessions
  for (const [id, session] of terminalSessions) {
    try { if (session.process.kill) session.process.kill() } catch {}
  }
  terminalSessions.clear()
})
