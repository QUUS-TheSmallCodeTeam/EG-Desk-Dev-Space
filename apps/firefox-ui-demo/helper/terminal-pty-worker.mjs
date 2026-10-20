import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveTerminalShell, terminalDimensions, supportsWindowsConpty } from './terminal-platform.mjs'

// Microsoft recommends removing the inherited PSModulePath when an intermediate
// process starts Windows PowerShell from PowerShell 7. Windows PowerShell then
// constructs its own normal user/machine module paths. No registry or policy is changed.
export function windowsNativeShellEnvironment(env, choice) {
  const rebuildLegacyModules = choice.id === 'cmd'
    || path.win32.basename(choice.executable).toLowerCase() === 'powershell.exe'
  return Object.fromEntries(Object.entries(env).filter(([key]) =>
    !(rebuildLegacyModules && key.toLowerCase() === 'psmodulepath')))
}

// Only the owned worker uses process.exit. It has one PTY and exits after its
// native onExit plus output/IPC flush, so Windows reclaims native driver handles.
export function runTerminalPtyWorker({ parent = process, loadPty = () => import('node-pty'),
  platform = process.platform, release, resolveShell = resolveTerminalShell,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let initialized = false, native = null, nativeExited = false, ending = false, disconnected = false
  let nativeSpawnAttempted = false, nativeStopRequested = false
  let pendingBytes = 0, paused = false, outputChain = Promise.resolve(), orphanTimer = null
  const subscriptions = []
  const exit = code => {
    if (ending) return
    ending = true
    if (orphanTimer) clearTimer(orphanTimer)
    for (const disposable of subscriptions) disposable?.dispose?.()
    parent.exit(code)
  }
  const send = packet => new Promise((resolve, reject) => {
    if (disconnected || typeof parent.send !== 'function' || parent.connected === false) {
      reject(new Error('Parent terminal IPC is unavailable')); return
    }
    try { parent.send({ v: 1, ...packet }, error => error ? reject(error) : resolve()) }
    catch (error) { reject(error) }
  })
  const requestNativeStop = () => {
    if (!native || nativeExited || nativeStopRequested) return
    nativeStopRequested = true
    try { native.kill() }
    catch (error) { nativeStopRequested = false; throw error }
  }
  const stopOwnedNative = () => {
    try { requestNativeStop() } catch {}
    // Parent disappearance is not proof of native exit. Bounded termination of
    // this worker releases only its owned PTY; a parent will classify it UNKNOWN.
    if (!orphanTimer) {
      orphanTimer = setTimer(() => exit(1), 5000)
      orphanTimer?.unref?.()
    }
  }
  const nativeOutput = text => {
    if (ending || typeof text !== 'string') return
    // Preserve surrogate pairs at frame boundaries; ConPTY itself uses UTF-8.
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 16384, text.length)
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
      const data = text.slice(start, end)
      start = end
      const bytes = Buffer.byteLength(data, 'utf8')
      pendingBytes += bytes
      if (pendingBytes > 256 * 1024 && !paused && typeof native?.pause === 'function') {
        paused = true; native.pause()
      }
      outputChain = outputChain.then(() => send({ type: 'output', data })).finally(() => {
        pendingBytes -= bytes
        if (paused && pendingBytes < 128 * 1024 && !nativeExited && !ending) {
          paused = false; native?.resume?.()
        }
      })
    }
    void outputChain.catch(() => { disconnected = true; stopOwnedNative() })
  }
  const nativeExit = async receipt => {
    if (nativeExited || ending) return
    nativeExited = true
    try {
      if (!Number.isInteger(receipt?.exitCode)) throw new Error('Missing native exit code')
      await outputChain
      await send({ type: 'native-exit', exitCode: receipt.exitCode, signal: receipt.signal ?? null })
      // The IPC callback above has flushed native evidence. This worker has no
      // other session; its deliberate exit contains node-pty driver residue.
      exit(0)
    } catch { exit(1) }
  }
  const onMessage = async message => {
    if (!message || message.v !== 1 || ending || disconnected) return
    if (message.type === 'init') {
      if (initialized) return
      initialized = true
      try {
        if (platform !== 'win32' || !supportsWindowsConpty(release)
          || typeof message.cwd !== 'string' || !path.win32.isAbsolute(message.cwd)
          || !message.env || typeof message.env !== 'object' || Array.isArray(message.env)
          || Object.values(message.env).some(value => typeof value !== 'string')
          || !['powershell', 'cmd'].includes(message.shellId)) throw new Error('Invalid Windows terminal initialization')
        const size = terminalDimensions(message.cols, message.rows)
        const choice = resolveShell({ shellId: message.shellId },
          { platform, env: message.env, release })
        const initialization = message.powerShellInitialization
        if (initialization != null && (typeof initialization !== 'string' || initialization.length > 16384
          || initialization.includes('\0'))) throw new Error('Invalid trusted PowerShell initialization')
        const args = message.shellId === 'powershell' && initialization
          ? ['-NoLogo', '-NoProfile', '-NoExit', '-Command', initialization] : choice.args
        const loaded = await loadPty(), pty = loaded.default || loaded
        if (disconnected || ending) throw new Error('Terminal parent ended during driver initialization')
        nativeSpawnAttempted = true
        native = pty.spawn(choice.executable, args, { name: 'xterm-256color', ...size,
          cwd: message.cwd, env: windowsNativeShellEnvironment(message.env, choice),
          useConpty: true, conptyInheritCursor: false })
        subscriptions.push(native.onData(nativeOutput), native.onExit(nativeExit))
        native.on?.('error', () => {
          void send({ type: 'runtime-error' }).catch(() => {})
          stopOwnedNative()
        })
        await send({ type: 'ready', shellId: choice.id, transport: 'conpty', usePty: true })
      } catch {
        try { await send({ type: 'spawn-error', nativeCreated: nativeSpawnAttempted ? native ? true : null : false }) } catch {}
        if (native && !nativeExited) stopOwnedNative()
        else exit(1)
      }
      return
    }
    if (!initialized || !native || !['write', 'resize', 'kill'].includes(message.type)
      || typeof message.requestId !== 'string' || message.requestId.length > 160) return
    try {
      if (nativeExited || nativeStopRequested) {
        if (message.type !== 'kill') throw new Error('Native terminal is stopping or has exited')
      } else if (message.type === 'write') {
        if (typeof message.data !== 'string' || Buffer.byteLength(message.data, 'utf8') > 64 * 1024) throw new Error('Invalid input')
        native.write(message.data)
      } else if (message.type === 'resize') {
        const size = terminalDimensions(message.cols, message.rows)
        native.resize(size.cols, size.rows)
      } else requestNativeStop()
      await send({ type: 'ack', requestId: message.requestId, ok: true })
    } catch {
      try { await send({ type: 'ack', requestId: message.requestId, ok: false }) } catch {}
    }
  }
  const onDisconnect = () => { if (ending) return; disconnected = true; stopOwnedNative() }
  parent.on('message', onMessage)
  parent.on('disconnect', onDisconnect)
  return { dispose() {
    parent.removeListener('message', onMessage)
    parent.removeListener('disconnect', onDisconnect)
    onDisconnect()
  } }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (typeof process.send !== 'function') {
    console.error('The terminal PTY worker must be owned by the EG-Desk IPC adapter')
    process.exitCode = 1
  } else runTerminalPtyWorker()
}
