import { spawn } from 'node:child_process'
import { AppServerRpc } from './codex-app-server-rpc.mjs'
import { normalizeNativeAuth, publicAuthIdentityKey } from './codex-auth-state.mjs'
import { readCodexModelCatalog } from './codex-model-catalog.mjs'
import { chatError } from './codex-chat-values.mjs'
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

export function createCodexProfileAppServers({ resolveHome, env = process.env, cwd = process.cwd(), spawnChild = spawn,
  executable = () => resolveCodexExecutable(env), onNotification = () => {}, onServerRequest = () => {}, onConnection = () => {}, onChange = () => {} } = {}) {
  const clients = new Map(), stopping = new Set()
  let disposed = false, sequence = 0
  const current = client => clients.get(client.id) === client && !disposed
  const changed = () => { try { onChange() } catch {} }

  function close(client, { kill = true } = {}) {
    if (clients.get(client.id) !== client) return
    clients.delete(client.id)
    client.rpc.close(offline())
    client.pending.clear()
    try { client.child.stdin.destroy() } catch {}
    if (kill) stopChild(client.child)
    onConnection(client.id, { ready: false, processLost: true })
    changed()
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
    const child = spawnChild(executable(), [...plan.args, '-c', 'cli_auth_credentials_store=file'], {
      cwd, env: isolatedCodexEnv(env, plan.envOverrides.CODEX_HOME), shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    })
    const client = { id, home, identity, child, auth: null, models: null, check: null, pending: new Map() }
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
        if (!client.auth?.isLoggedIn) return
        if (message.method === 'serverRequest/resolved') {
          const entry = [...client.pending].find(([, nativeId]) => nativeId === message.params?.requestId)
          if (!entry) return
          client.pending.delete(entry[0])
          onNotification(id, { ...message, params: { ...message.params, requestId: entry[0] } })
        } else onNotification(id, message)
      },
      onRequest: message => {
        if (!current(client)) return
        if (!client.auth?.isLoggedIn || client.pending.size >= MAX_SERVER_REQUESTS) {
          if (rpc.ready) rpc.respond(message.id, undefined, { code: -32000, message: 'No ready EG-Desk profile session' })
          return
        }
        // Server IDs are per-connection. An old callback cannot reply to a
        // new process or to the same native ID on a different profile.
        const opaque = `codex-profile:${++sequence}`
        client.pending.set(opaque, message.id)
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
        rpc.receive(line)
        if (!current(client)) return
      }
      if (buffer.length > RPC_LINE_LIMIT) close(client)
    })
    client.init = (async () => {
      await rpc.initialize()
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
    request(id, method, params) { return readyClient(id).rpc.request(method, params) },
    respond(id, rpcId, result, error) {
      const client = readyClient(id)
      if (!client.pending.has(rpcId)) throw chatError('ENGINE_PROFILE_MISMATCH', 'The request is not pending on this Codex profile', 403)
      const nativeId = client.pending.get(rpcId)
      client.pending.delete(rpcId)
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
