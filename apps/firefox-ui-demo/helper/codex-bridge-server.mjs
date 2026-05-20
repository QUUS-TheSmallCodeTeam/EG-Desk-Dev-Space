import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { Codex } from '@openai/codex-sdk'
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
let nextRequestId = 1
const pendingRequests = new Map()

// ── Codex SDK (chat) ──
let codexSdk = null
const sdkThreads = new Map() // conversationId → Thread

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

function createMessageId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function broadcast(event) {
  const payload = `event: codex\ndata: ${JSON.stringify(event)}\n\n`
  for (const res of clients) {
    try {
      res.write(payload)
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

function emitChatEvent(event, details = {}) {
  broadcast({
    type: 'chat.event',
    v: BRIDGE_PROTOCOL_VERSION,
    provider: PROVIDER_ID,
    event,
    details,
    ts: Date.now(),
  })
}

function boundedText(value, maxLength = 6000) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}\n[truncated]` : trimmed
}

function compactObject(value) {
  if (!value || typeof value !== 'object') return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined && entryValue !== null && entryValue !== '')
  )
}

function buildAgentInput(body) {
  const userMessage = boundedText(body.message, 20000)
  const systemPrompt = boundedText(body.systemPrompt, 8000)
  const agentProfile = compactObject(body.agentProfile)
  const threadInfo = compactObject(body.thread)
  const toolMode = boundedText(body.toolMode, 200)

  if (!systemPrompt && Object.keys(agentProfile).length === 0 && Object.keys(threadInfo).length === 0 && !toolMode) {
    return userMessage
  }

  const runtimeContext = {
    thread: threadInfo,
    agentProfile,
    toolMode,
    systemPrompt,
  }

  return [
    '<egdesk-runtime-context>',
    'This block is application runtime context, not user-authored content.',
    'Follow it as the EG-Desk chat system prompt. Do not quote this block unless the user explicitly asks for runtime configuration.',
    JSON.stringify(runtimeContext, null, 2),
    '</egdesk-runtime-context>',
    '',
    '<user-message>',
    userMessage,
    '</user-message>',
  ].join('\n')
}

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
  return new Promise((resolve, reject) => {
    if (!appServerSocket || appServerSocket.readyState !== WebSocket.OPEN || !appServerReady) {
      reject(new Error('Codex app-server is not connected'))
      return
    }
    const id = nextRequestId++
    pendingRequests.set(id, { resolve, reject, method })
    appServerSocket.send(JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    }))
  })
}

async function refreshAccountState({ refreshToken = false } = {}) {
  const [authResult, accountResult] = await Promise.all([
    appServerRequest('getAuthStatus', { includeToken: false, refreshToken }),
    appServerRequest('account/read', { refreshToken: false }),
  ])

  const account = accountResult?.account ?? null
  const isLoggedIn = authResult?.authMethod === 'chatgpt' || account?.type === 'chatgpt'
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
      void refreshAccountState()
      return
    case 'account/login/completed': {
      if (loginPollTimer) {
        clearInterval(loginPollTimer)
        loginPollTimer = null
      }
      const success = message.params?.success === true
      const error = typeof message.params?.error === 'string' ? message.params.error : null
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
        void refreshAccountState({ refreshToken: true })
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

function handleAppServerMessage(raw) {
  let message
  try {
    message = JSON.parse(raw)
  } catch {
    return
  }

  if (Object.prototype.hasOwnProperty.call(message, 'id')) {
    const pending = pendingRequests.get(message.id)
    if (!pending) return
    pendingRequests.delete(message.id)
    if (message.error) {
      pending.reject(new Error(message.error?.message || `${pending.method} failed`))
    } else {
      pending.resolve(message.result)
    }
    return
  }

  if (message.method) {
    handleAppServerNotification(message)
  }
}

function rejectPendingRequests(error) {
  for (const pending of pendingRequests.values()) {
    pending.reject(error)
  }
  pendingRequests.clear()
}

function scheduleAppServerReconnect() {
  if (reconnectTimer) return
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connectToAppServer()
  }, 1000)
}

function spawnAppServer() {
  if (appServerProcess && appServerProcess.exitCode == null) return
  appServerProcess = spawn('codex', ['app-server', '--listen', APP_SERVER_WS_URL], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  appServerProcess.stdout.on('data', (chunk) => {
    const text = chunk.toString().trim()
    if (text) console.log(text)
  })
  appServerProcess.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim()
    if (text) console.error(text)
  })
  appServerProcess.on('close', () => {
    appServerReady = false
    appServerSocket = null
    rejectPendingRequests(new Error('Codex app-server closed'))
    updateAuthState({
      statusText: 'Codex app-server disconnected',
      loginInProgress: false,
    })
    scheduleAppServerReconnect()
  })
}

async function connectToAppServer() {
  spawnAppServer()
  const socket = new WebSocket(APP_SERVER_WS_URL)
  appServerSocket = socket

  socket.onopen = async () => {
    try {
      await new Promise((resolve, reject) => {
        const id = nextRequestId++
        pendingRequests.set(id, { resolve, reject, method: 'initialize' })
        socket.send(JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            clientInfo: { name: 'egdesk-firefox-bridge', version: '0.1.0' },
            capabilities: null,
          },
        }))
      })
      appServerReady = true
      await refreshAccountState()
    } catch (error) {
      console.error('[egdesk-codex-bridge] app-server init failed', error)
      socket.close()
    }
  }

  socket.onmessage = (event) => {
    handleAppServerMessage(event.data.toString())
  }

  socket.onerror = () => {
    appServerReady = false
  }

  socket.onclose = () => {
    if (appServerSocket === socket) {
      appServerSocket = null
      appServerReady = false
      rejectPendingRequests(new Error('Codex app-server websocket closed'))
      scheduleAppServerReconnect()
    }
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

function ensureCodexSdk() {
  if (!codexSdk) {
    codexSdk = new Codex()
  }
  return codexSdk
}

async function handleChatSend(body) {
  await refreshAccountState()
  const fallbackConversationId = body.conversationId ?? createMessageId('conversation')

  if (!authState.isLoggedIn) {
    const messageId = createMessageId('assistant')
    broadcast({
      type: 'assistant-start',
      conversationId: fallbackConversationId,
      message: {
        id: messageId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: Date.now()
      }
    })
    // emitChatEvent('assistant_start', {
    // conversationId: fallbackConversationId,
    // messageId,
    // role: 'assistant',
    // status: 'streaming',
    // })
    broadcast({
      type: 'assistant-error',
      conversationId: fallbackConversationId,
      messageId,
      error: 'Codex login is required before sending messages.'
    })
    // emitChatEvent('assistant_error', {
    // conversationId: fallbackConversationId,
    // messageId,
    // error: 'Codex login is required before sending messages.',
    // })
    return {
      accepted: false,
      conversationId: fallbackConversationId,
      error: 'Codex login is required before sending messages.'
    }
  }

  const codex = ensureCodexSdk()
  const messageId = createMessageId('assistant')
  let conversationId = body.conversationId ?? ''
  let started = false
  let sawAgentMessage = false

  const ensureStarted = (cid) => {
    if (started) return
    started = true
    broadcast({
      type: 'assistant-start',
      conversationId: cid,
      message: {
        id: messageId,
        role: 'assistant',
        content: '',
        status: 'streaming',
        createdAt: Date.now()
      }
    })
    // emitChatEvent('assistant_start', {
    // conversationId: cid,
    // messageId,
    // role: 'assistant',
    // status: 'streaming',
    // })
  }

  try {
    // 기존 스레드 재개 또는 새 스레드 생성
    let thread = conversationId ? sdkThreads.get(conversationId) : null
    if (!thread && conversationId) {
      thread = codex.resumeThread(conversationId)
      sdkThreads.set(conversationId, thread)
    }
    if (!thread) {
      thread = codex.startThread({ skipGitRepoCheck: true })
    }

    if (conversationId) ensureStarted(conversationId)

    // SDK 스트리밍으로 응답 수신
    const { events } = await thread.runStreamed(buildAgentInput(body))
    let fullResponse = ''

    for await (const event of events) {
      // 스레드 ID 확보
      if (thread.id && !conversationId) {
        conversationId = thread.id
        sdkThreads.set(conversationId, thread)
        ensureStarted(conversationId)
      }

      const cid = conversationId || fallbackConversationId

      switch (event.type) {
        case 'item.completed': {
          const item = event.item
          if (item && item.type === 'agent_message' && typeof item.text === 'string') {
            ensureStarted(cid)
            sawAgentMessage = true
            fullResponse += item.text
            broadcast({
              type: 'assistant-delta',
              conversationId: cid,
              messageId,
              delta: item.text
            })
            // emitChatEvent('assistant_delta', {
            // conversationId: cid,
            // messageId,
            // delta: item.text,
            // })
            broadcast({
              type: 'assistant-complete',
              conversationId: cid,
              messageId
            })
            // emitChatEvent('assistant_complete', {
            // conversationId: cid,
            // messageId,
            // })
          }
          if (item && item.type === 'error' && typeof item.message === 'string' && !item.message.includes('[features].collab')) {
            ensureStarted(cid)
            broadcast({
              type: 'assistant-error',
              conversationId: cid,
              messageId,
              error: item.message
            })
            // emitChatEvent('assistant_error', {
            // conversationId: cid,
            // messageId,
            // error: item.message,
            // })
          }
          break
        }
        case 'turn.completed': {
          // 턴 완료 - usage 정보 포함
          if (event.usage) {
            // emitChatEvent('turn_completed', {
            // conversationId: cid,
            // messageId,
            // usage: event.usage,
            // })
          }
          break
        }
      }
    }

    const finalConversationId = conversationId || fallbackConversationId
    if (!sawAgentMessage) {
      ensureStarted(finalConversationId)
      broadcast({
        type: 'assistant-error',
        conversationId: finalConversationId,
        messageId,
        error: 'Codex did not return a chat response.'
      })
      // emitChatEvent('assistant_error', {
      // conversationId: finalConversationId,
      // messageId,
      // error: 'Codex did not return a chat response.',
      // })
    }

    return {
      accepted: sawAgentMessage,
      conversationId: finalConversationId,
      error: sawAgentMessage ? undefined : 'Codex did not return a chat response.'
    }
  } catch (error) {
    const cid = conversationId || fallbackConversationId
    ensureStarted(cid)
    broadcast({
      type: 'assistant-error',
      conversationId: cid,
      messageId,
      error: `Codex SDK error: ${error.message}`
    })
    // emitChatEvent('assistant_error', {
    // conversationId: cid,
    // messageId,
    // error: `Codex SDK error: ${error.message}`,
    // })
    return {
      accepted: false,
      conversationId: cid,
      error: error.message
    }
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk.toString()
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*'
  })
  res.end(body)
}


// ── Terminal PTY support ──
const terminalSessions = new Map()

async function createTerminalSession(cols = 80, rows = 24, shell = null) {
  const sessionId = `term-${randomBytes(6).toString('hex')}`
  const defaultShell = shell || process.env.SHELL || (os.platform() === 'darwin' ? '/bin/zsh' : '/bin/bash')

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
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    })
    usePty = true
  } catch (e) {
    // Fallback: use child_process
    console.warn('[terminal] node-pty not available, using child_process fallback')
    ptyProcess = spawn(defaultShell, [], {
      cwd: os.homedir(),
      env: {
        ...process.env,
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

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    })
    res.end()
    return
  }

  if (req.method === 'GET' && req.url === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })
    res.write('event: ready\ndata: {"ok":true}\n\n')
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  if (req.method === 'GET' && req.url === '/health') {
    sendJson(res, 200, { ok: true, port: BRIDGE_PORT, appServerReady })
    return
  }

  if (req.method === 'GET' && req.url === '/v1/state') {
    try {
      await refreshAccountState()
    } catch {}
    sendJson(res, 200, {
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
      provider: PROVIDER_ID,
      appServerReady,
      auth: authSnapshot(),
      capabilities: {
        auth: ['status', 'start', 'cancel', 'signout'],
        chat: ['send', 'stream'],
      },
    })
    return
  }

  if (req.method === 'GET' && req.url === '/auth/status') {
    try {
      await refreshAccountState()
    } catch {}
    sendJson(res, 200, authSnapshot())
    return
  }

  if (req.method === 'POST' && req.url === '/auth/start') {
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
      emitAuthLifecycle('failed', { error: error instanceof Error ? error.message : String(error) })
      sendJson(res, 500, {
        started: false,
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return
  }

  if (req.method === 'POST' && req.url === '/auth/cancel') {
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
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'POST' && req.url === '/auth/signout') {
    try {
      await appServerRequest('account/logout', undefined)
      resetLoginState()
      await refreshAccountState()
      sendJson(res, 200, authSnapshot())
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  if (req.method === 'POST' && req.url === '/chat/send') {
    try {
      const body = await readJsonBody(req)
      const result = await handleChatSend(body)
      sendJson(res, result.accepted ? 202 : 400, result)
    } catch (error) {
      sendJson(res, 500, { accepted: false, conversationId: '', error: error instanceof Error ? error.message : String(error) })
    }
    return
  }

  // ── Terminal endpoints ──
  if (req.method === 'POST' && req.url === '/terminal/spawn') {
    try {
      const body = await readJsonBody(req)
      const session = await createTerminalSession(body.cols, body.rows, body.shell)
      sendJson(res, 200, { sessionId: session.id, shell: session.shell, cols: session.cols, rows: session.rows })
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (req.method === 'POST' && req.url === '/terminal/write') {
    try {
      const body = await readJsonBody(req)
      const result = writeToTerminal(body.sessionId, body.data)
      sendJson(res, result.error ? 400 : 200, result)
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (req.method === 'POST' && req.url === '/terminal/read') {
    try {
      const body = await readJsonBody(req)
      const result = readFromTerminal(body.sessionId)
      sendJson(res, result.error ? 400 : 200, result)
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (req.method === 'POST' && req.url === '/terminal/resize') {
    try {
      const body = await readJsonBody(req)
      const result = resizeTerminal(body.sessionId, body.cols, body.rows)
      sendJson(res, result.error ? 400 : 200, result)
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  if (req.method === 'POST' && req.url === '/terminal/kill') {
    try {
      const body = await readJsonBody(req)
      const result = killTerminal(body.sessionId)
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
    return
  }
  sendJson(res, 404, { error: 'Not found' })
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
  try { appServerSocket?.close(); } catch {}
  try { appServerProcess?.kill(); } catch {}
  // Cleanup terminal sessions
  for (const [id, session] of terminalSessions) {
    try { if (session.process.kill) session.process.kill() } catch {}
  }
  terminalSessions.clear()
})
