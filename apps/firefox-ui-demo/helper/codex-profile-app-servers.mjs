import { spawn } from 'node:child_process'
import { AppServerRpc } from './codex-app-server-rpc.mjs'
import { normalizeNativeAuth, publicAuthIdentityKey } from './codex-auth-state.mjs'
import { readCodexModelCatalog } from './codex-model-catalog.mjs'
import { chatError, publicErrorKind } from './codex-chat-values.mjs'
import { buildCodexAppServerLaunch, preflightOwnedAppServer, resolveCodexExecutable } from './egdesk-native-capabilities.mjs'

// No shared Codex env/auth, dotenv, provider/API/proxy overrides, or shell.
// Keep only paths and OS/locale necessities; Codex resolves its state in the
// explicitly owned home and uses the same file-only backend as its CLI login.
const OS_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USERPROFILE|LANG|LC_[A-Z_]+)$/i
export function isolatedCodexEnv(env, home) {
  return { ...Object.fromEntries(Object.entries(env).filter(([name]) => OS_ENV.test(name))), CODEX_HOME: home }
}

const offline = () => chatError('ENGINE_UNAVAILABLE', 'The selected Codex profile is not connected', 503)
const loginRequired = () => chatError('ENGINE_LOGIN_REQUIRED', 'Sign in to the selected Codex profile first', 401)
const RPC_LINE_LIMIT = 32 * 1024 * 1024
const MAX_SERVER_REQUESTS = 4096
const AUTH_REJECTION_MESSAGE = /^(?:request failed:\s*)?(?:401\s+)?(?:unauthori[sz]ed|(?:you are )?not (?:logged|signed) in|(?:please )?(?:log|sign) in again|(?:please )?re-?authenticate|authentication required|(?:your )?token (?:has )?expired)(?:[.!](?:\s+please\b[^\r\n]*)?)?$/i

function isAuthRejection(error) {
  if (error?.code === 401) return true
  const info = error?.codexErrorInfo ?? error?.data?.codexErrorInfo
  if (info != null) return publicErrorKind({ codexErrorInfo: info }) === 'auth'
  // Untyped RPC errors can carry plain text. Require an auth declaration,
  // not an auth-related word in a request, tool error, or other diagnostic.
  const message = error?.message
  return typeof message === 'string' && message.length <= 2000 && AUTH_REJECTION_MESSAGE.test(message.trim())
}

export function createCodexProfileAppServers({ resolveHome, env = process.env, cwd = process.cwd(), spawnChild = spawn,
  executable = () => resolveCodexExecutable(env), getBoardPeerContract = () => null, inspectCapabilities = null, onNotification = () => {}, onServerRequest = () => {}, onConnection = () => {}, onChange = () => {},
  onVersion = () => {} } = {}) {
  const clients = new Map(), stopping = new Set()
  let disposed = false, sequence = 0
  const current = client => clients.get(client.id) === client && !disposed
  const changed = () => { try { onChange() } catch {} }

  function close(client, { kill = true } = {}) {
    if (clients.get(client.id) !== client) return
    clients.delete(client.id)
    client.rpc.close(offline())
    client.pending.clear()
    client.nativeRequests.clear()
    client.answered.clear()
    try { client.child.stdin.destroy() } catch {}
    if (kill) stopChild(client.child)
    onConnection(client.id, { ready: false, processLost: true })
    changed()
  }

  function rejectAuth(client) {
    // Discard this process and its auth cache. Any in-flight check is now
    // stale; only a new scoped handshake, account/read and catalog read can
    // publish readiness again. No shared client or login is touched.
    client.authRejected = true
    close(client)
  }

  function stopChild(child) {
    if (child.exitCode != null || child.signalCode != null) return
    const record = { child, done: null, force: null }
    record.done = new Promise(resolve => {
      const finish = () => { clearTimeout(record.force); stopping.delete(record); resolve() }
      record.force = setTimeout(() => {
        try { child.kill('SIGKILL') } catch {}
        finish()
      }, 1500)
      record.force.unref?.()
      child.once('close', finish)
      stopping.add(record)
      try { if (child.kill('SIGTERM') === false) finish() } catch { finish() }
    })
  }

  function resolve(id) {
    if (disposed) throw offline()
    const existing = clients.get(id)
    let home
    try { home = resolveHome(id) }
    catch (error) { if (existing) close(existing); throw error }
    if (existing && (existing.home !== home.home || existing.identity !== home.identity)) {
      close(existing)
      throw chatError('ENGINE_PROFILE_HOME_UNAVAILABLE', 'The selected Codex profile folder changed', 409)
    }
    return { existing, home }
  }

  function launch(id, owned) {
    const { home, identity } = owned
    const plan = buildCodexAppServerLaunch({ env, listen: 'stdio://', codexHome: home })
    const bin = executable(id)
    // L1 c22: what THIS profile's binary can do comes from its own probe (inspectCapabilities), never from the shared app-server's. Without a probe
    // (older callers, tests) the previous peer-input hook still answers and nothing else is claimed.
    let capabilities = null
    if (typeof inspectCapabilities === 'function') { try { capabilities = inspectCapabilities(bin) ?? null } catch { capabilities = null } }
    let boardPeerContract = null, steerContract = null
    // With a probe configured nothing is borrowed, not even when this binary's probe failed (then it claims nothing).
    if (typeof inspectCapabilities === 'function') { boardPeerContract = capabilities?.boardPeerContract ?? null; steerContract = capabilities?.steerContract ?? null }
    else { try { boardPeerContract = getBoardPeerContract(bin) } catch { /* optional; chat remains available */ } }
    const child = spawnChild(bin, [...plan.args, '-c', 'cli_auth_credentials_store=file'], {
      cwd, env: isolatedCodexEnv(env, plan.envOverrides.CODEX_HOME), shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const client = { id, home, identity, child, boardPeerContract, steerContract, capabilities, auth: null, models: null, check: null, authRejected: false,
      pending: new Map(), nativeRequests: new Map(), answered: new Set() }
    const rpc = client.rpc = new AppServerRpc({
      experimentalApi: true,
      send: payload => child.stdin.write(`${payload}\n`),
      onNotification: message => {
        if (!current(client)) return
        if (message.method === 'account/updated') {
          // A changed CLI login must never inherit a previous identity's
          // in-flight threads. Reconnect on explicit refresh or new send.
          if (client.auth?.isLoggedIn) close(client)
          return
        }
        const error = message.method === 'error' && message.params?.willRetry !== true ? message.params?.error
          : message.method === 'turn/completed' ? message.params?.turn?.error : null
        if (isAuthRejection(error)) { rejectAuth(client); return }
        if (!client.auth?.isLoggedIn) return
        if (message.method === 'serverRequest/resolved') {
          const nativeId = message.params?.requestId, opaque = client.nativeRequests.get(nativeId)
          if (!opaque) return
          client.nativeRequests.delete(nativeId)
          client.pending.delete(opaque)
          client.answered.delete(nativeId)
          onNotification(id, { ...message, params: { ...message.params, requestId: opaque } })
        } else onNotification(id, message)
      },
      onRequest: message => {
        if (!current(client) || client.nativeRequests.has(message.id)) return
        if (!client.auth?.isLoggedIn || client.pending.size >= MAX_SERVER_REQUESTS) {
          if (rpc.ready) rpc.respond(message.id, undefined, { code: -32000, message: 'No ready EG-Desk profile session' })
          return
        }
        // Server IDs are per-connection. An old callback cannot reply to a
        // new process or to the same native ID on a different profile.
        const opaque = `codex-profile:${++sequence}`
        client.pending.set(opaque, message.id)
        client.nativeRequests.set(message.id, opaque)
        onServerRequest(id, { ...message, id: opaque })
      },
    })
    clients.set(id, client)
    child.on('error', () => close(client))
    child.on('close', () => close(client, { kill: false }))
    child.stdin.on('error', () => close(client))
    child.stdout.on('error', () => close(client))
    child.stderr.on('error', () => close(client))
    // Keep stderr drained without publishing native logs or auth data.
    child.stderr.resume()
    child.stdout.setEncoding('utf8')
    let buffer = ''
    child.stdout.on('data', chunk => {
      if (!current(client)) return
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        if (newline > RPC_LINE_LIMIT) { close(client); return }
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        // Inspect only possible error frames: AppServerRpc preserves the
        // caller's error but does not expose its structured wire data. Match
        // outstanding client requests; unsolicited errors are not evidence.
        let authRejected = false
        if (line.includes('"error"')) {
          let message
          try { message = JSON.parse(line) } catch {}
          authRejected = typeof message?.method !== 'string' && rpc.pending.has(message?.id) && isAuthRejection(message?.error)
        }
        rpc.receive(line)
        if (authRejected && current(client)) rejectAuth(client)
        if (!current(client)) return
      }
      if (buffer.length > RPC_LINE_LIMIT) close(client)
    })
    client.init = (async () => {
      await rpc.initialize()
      // The build this profile's app-server reports (InitializeResponse.userAgent), for the command gate's version pin. Recording only.
      if (current(client)) { try { onVersion(id, { userAgent: rpc.serverInfo?.userAgent ?? null }) } catch { /* recording only */ } }
      const proof = await preflightOwnedAppServer({ launch: plan, cwd, request: (m, p) => rpc.request(m, p), isCurrent: () => current(client) })
      if (!proof.ready || !current(client)) throw offline()
    })()
    return client
  }

  async function refresh(id, { restartSignedOut = false } = {}) {
    let { existing: client, home } = resolve(id)
    // A CLI login happened in a different process. Do not rely on an
    // already-running signed-out App Server to reload its auth cache.
    if (restartSignedOut && client?.auth?.isLoggedIn === false && !client.check) { close(client); client = null }
    if (!client) {
      try { client = launch(id, home) } catch { throw offline() }
    }
    if (client.check) return client.check
    const check = (async () => {
      try {
        await client.init
        const account = await client.rpc.request('account/read', { refreshToken: false })
        if (resolve(id).existing !== client) throw offline()
        const auth = normalizeNativeAuth(null, account)
        auth.isLoggedIn = auth.isLoggedIn && Boolean(publicAuthIdentityKey(auth))
        const owner = publicAuthIdentityKey(auth)
        if (client.auth?.isLoggedIn && (!auth.isLoggedIn || owner !== publicAuthIdentityKey(client.auth))) throw loginRequired()
        const models = auth.isLoggedIn ? await readCodexModelCatalog((m, p) => client.rpc.request(m, p)) : null
        if (resolve(id).existing !== client) throw offline()
        const wasReady = client.auth?.isLoggedIn === true
        client.auth = auth
        client.models = models
        if (!wasReady && auth.isLoggedIn) onConnection(id, { ready: true })
        changed()
        return { auth, models }
      } catch (error) {
        close(client)
        if (client.authRejected) throw loginRequired()
        if (error?.httpStatus) throw error
        throw offline()
      }
    })()
    client.check = check
    try { return await check } finally { if (client.check === check) client.check = null }
  }

  function readyClient(id) {
    const { existing } = resolve(id)
    if (!existing?.rpc.ready || !existing.auth?.isLoggedIn) throw offline()
    return existing
  }

  return {
    refresh,
    async ensureReady(id) {
      if (!(await refresh(id)).auth.isLoggedIn) throw loginRequired()
      readyClient(id)
    },
    boardPeerContract(id) { return readyClient(id).boardPeerContract },
    steerContract(id) { return readyClient(id).steerContract ?? null },
    /** What this profile's own binary can do (dynamicTools, ephemeral, turnSteer, threadDelete), for a ready profile; all false otherwise. */
    capabilities(id) {
      const none = Object.freeze({ version: null, dynamicTools: false, qaReadOnly: false, ephemeral: false, turnSteer: false, threadDelete: false, boardPeerContract: null, steer: false, steerContract: null, executable: null })
      try {
        const client = clients.get(id), owned = resolveHome(id)
        if (!client || !current(client) || client.home !== owned.home || client.identity !== owned.identity || !client.rpc.ready || !client.auth?.isLoggedIn) return none
        return client.capabilities ?? none
      } catch { return none }
    },
    request(id, method, params) { return readyClient(id).rpc.request(method, params) },
    respond(id, rpcId, result, error) {
      const client = readyClient(id)
      if (!client.pending.has(rpcId)) throw chatError('ENGINE_PROFILE_MISMATCH', 'The request is not pending on this Codex profile', 403)
      const nativeId = client.pending.get(rpcId)
      client.pending.delete(rpcId)
      // A reply ends the right to respond, not the correlation for the UI's
      // later resolution event. Keep a bounded FIFO independent of active work.
      client.answered.add(nativeId)
      if (client.answered.size > MAX_SERVER_REQUESTS) {
        const oldest = client.answered.values().next().value
        client.answered.delete(oldest)
        client.nativeRequests.delete(oldest)
      }
      client.rpc.respond(nativeId, result, error)
    },
    snapshot(id) {
      // A descriptor is read-only; validate the directory without emitting
      // connection events recursively from engine.status projection.
      try {
        const client = clients.get(id), owned = resolveHome(id)
        if (!current(client || {}) || client.home !== owned.home || client.identity !== owned.identity) return null
        return { auth: client.auth, models: client.models }
      } catch { return null }
    },
    reconcile() { for (const id of clients.keys()) { try { resolve(id) } catch {} } },
    residentCount: () => clients.size,
    killAll() {
      for (const { child } of clients.values()) { try { child.kill('SIGKILL') } catch {} }
      for (const { child } of stopping) { try { child.kill('SIGKILL') } catch {} }
    },
    async dispose() {
      if (!disposed) {
        disposed = true
        for (const client of clients.values()) close(client)
      }
      await Promise.all([...stopping].map(record => record.done))
    },
  }
}
