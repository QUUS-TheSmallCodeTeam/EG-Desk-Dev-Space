import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn as spawnChild } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWindowsPtyProcess } from './terminal-windows-process.mjs'

const fail = (code, message, httpStatus = 400, details = {}) => {
  throw Object.assign(new Error(message), { code, httpStatus, ...details })
}
const envValue = (env, name) => env[Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase())]
const isFile = candidate => { try { return fs.statSync(candidate).isFile() } catch { return false } }

export function terminalDimensions(cols = 80, rows = 24) {
  if (!Number.isSafeInteger(cols) || cols < 2 || cols > 1000
    || !Number.isSafeInteger(rows) || rows < 1 || rows > 1000) {
    fail('INVALID_TERMINAL_SIZE', 'Terminal columns must be 2–1000 and rows 1–1000')
  }
  return { cols, rows }
}

export function windowsBuildNumber(release = os.release()) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:\.\d+)?$/.exec(release)
  return match && Number(match[1]) >= 10 ? Number(match[3]) : null
}

export function supportsWindowsConpty(release = os.release()) {
  // node-pty 1.1.0 gates its actual ConPTY backend by the build component.
  const build = windowsBuildNumber(release)
  return build !== null && build >= 18309
}

export function terminalShellCatalog({ platform = process.platform, env = process.env,
  exists = isFile, release = os.release() } = {}) {
  if (platform !== 'win32') {
    const executable = envValue(env, 'SHELL') || (platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
    return { ok: true, platform, defaultShellId: 'default', transport: 'pty', ptyRequired: false,
      shells: [{ id: 'default', label: path.posix.basename(executable), available: true, executable }] }
  }
  const systemRoot = envValue(env, 'SystemRoot') || envValue(env, 'WINDIR') || 'C:\\Windows'
  // User-facing shells must not depend on a hidden Codex runtime/cache PATH.
  const roots = [...new Set([envValue(env, 'ProgramW6432'), envValue(env, 'ProgramFiles')].filter(Boolean))]
  const pwsh = roots.map(root => path.win32.join(root, 'PowerShell', '7', 'pwsh.exe')).find(exists)
  const powershell = pwsh || path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const systemCmd = path.win32.join(systemRoot, 'System32', 'cmd.exe')
  const comspec = envValue(env, 'ComSpec')
  const cmd = typeof comspec === 'string' && path.win32.normalize(comspec).toLowerCase() === systemCmd.toLowerCase()
    ? comspec : systemCmd
  const supported = supportsWindowsConpty(release)
  return { ok: true, platform, defaultShellId: 'powershell',
    transport: supported ? 'conpty' : 'unavailable', ptyRequired: true,
    windowsBuildNumber: windowsBuildNumber(release),
    ...(supported ? {} : { reason: 'WINDOWS_CONPTY_UNSUPPORTED' }),
    shells: [
      { id: 'powershell', label: pwsh ? 'PowerShell 7' : 'Windows PowerShell', available: exists(powershell), executable: powershell },
      { id: 'cmd', label: 'CMD', available: exists(cmd), executable: cmd },
    ] }
}

export function resolveTerminalShell({ shellId, shell } = {}, options = {}) {
  const catalog = terminalShellCatalog(options)
  if (catalog.platform === 'win32') {
    if (shellId != null && shell != null && shellId !== shell) {
      fail('INVALID_TERMINAL_SHELL', 'Use one typed Windows shell selection')
    }
    const selected = shellId ?? shell ?? catalog.defaultShellId
    const id = selected === 'default' ? catalog.defaultShellId : selected
    if (typeof id !== 'string' || !['powershell', 'cmd'].includes(id)) {
      fail('INVALID_TERMINAL_SHELL', 'Windows terminal shell must be powershell or cmd')
    }
    const choice = catalog.shells.find(item => item.id === id)
    if (!choice?.available) fail('TERMINAL_SHELL_UNAVAILABLE', 'The selected Windows shell is not installed', 503)
    return { ...choice, args: id === 'cmd' ? ['/D'] : ['-NoLogo', '-NoProfile'] }
  }
  if (shellId != null && shellId !== 'default') fail('INVALID_TERMINAL_SHELL', 'This platform accepts the default shell ID')
  const executable = shell ?? catalog.shells[0].executable
  if (typeof executable !== 'string' || !executable || executable.length > 4096 || /[\0\r\n]/.test(executable)) {
    fail('INVALID_TERMINAL_SHELL', 'A bounded POSIX shell executable is required')
  }
  return { id: 'default', label: path.posix.basename(executable), executable, args: [], available: true }
}

// u1 (item 4): the bridge runs under Aside's own runtime, and its environment carries that runtime's private settings (NPM_CONFIG_PREFIX, NODE_PATH, VIRTUAL_ENV, TMPDIR, ... all pointing
// into ~/.aside). A shell started with them prints "nvm is not compatible with the NPM_CONFIG_PREFIX environment variable" on its first line and lets npm/pip/node of the person's own
// tools write into Aside's folders. These variables are not the person's: a value that points into an Aside directory, or a name that starts with ASIDE_, is not handed to the shell.
// PATH, PWD and OLDPWD are kept as they are (a missing tool is worse than an extra folder; the shell and the person's rc files own PATH). Every other variable, including a person's own
// NPM_CONFIG_PREFIX, is passed unchanged, and the shell still reads the person's rc files itself.
const ASIDE_DIR = /(^|[\\/])\.aside([\\/]|$)/
const KEEP_AS_IS = new Set(['PATH', 'PWD', 'OLDPWD', 'HOME', 'USERPROFILE'])
export function withoutAsideRuntimeEnv(env = process.env) {
  const out = {}
  for (const [name, value] of Object.entries(env ?? {})) {
    if (!KEEP_AS_IS.has(name.toUpperCase())) {
      if (/^ASIDE_/i.test(name)) continue
      if (typeof value === 'string' && ASIDE_DIR.test(value)) continue
    }
    out[name] = value
  }
  return out
}

export function terminalEnvironment(env = process.env, platform = process.platform) {
  env = withoutAsideRuntimeEnv(env)
  const result = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
  if (platform !== 'win32') {
    const utf8 = value => typeof value === 'string' && /utf-?8/i.test(value)
    result.LANG = utf8(env.LANG) ? env.LANG : 'ko_KR.UTF-8'
    result.LC_CTYPE = utf8(env.LC_CTYPE) ? env.LC_CTYPE : result.LANG
  }
  return result
}

// Injected native modules/process factories make shell/HTTP tests independent
// of Codex, app-server, global ports, a browser, and real terminal processes.
export function createTerminalSessionFactory({ registry, platform = process.platform,
  env = process.env, release = os.release(), cwd = os.homedir(), exists = isFile,
  loadPty = () => import('node-pty'), spawnPipe = spawnChild,
  startWindowsProcess = createWindowsPtyProcess, windowsPowerShellInitialization = null,
  newId = () => 'term-' + randomBytes(6).toString('hex'), warn = console.warn, openUrl = null } = {}) {
  if (!registry || typeof registry.register !== 'function') throw new TypeError('A terminal registry is required')
  if (typeof cwd !== 'string' || !(platform === 'win32' ? path.win32 : path).isAbsolute(cwd)) {
    throw new TypeError('A trusted absolute terminal working directory is required')
  }
  const catalog = () => terminalShellCatalog({ platform, env, release, exists })
  let ptyModule
  return {
    catalog,
    async create({ cols, rows, shellId, shell } = {}) {
      const size = terminalDimensions(cols, rows)
      const choice = resolveTerminalShell({ shellId, shell }, { platform, env, release, exists })
      if (platform === 'win32' && !supportsWindowsConpty(release)) {
        fail('WINDOWS_CONPTY_UNSUPPORTED', 'This Windows build is not supported by the installed ConPTY backend', 503,
          { transport: 'unavailable', usePty: false, degraded: false })
      }
      // c34 (flag EGDESK_TERMINAL_OPEN_URL, off = no openUrl): this session's opener variables, keyed by the id the session will have
      const sessionId = newId()
      const environment = { ...terminalEnvironment(env, platform), ...(openUrl && platform !== 'win32' ? openUrl.envFor(sessionId) : {}) }
      if (platform === 'win32') {
        let windowsProcess
        try {
          windowsProcess = await startWindowsProcess({ shellId: choice.id, cwd, ...size, env: environment,
            powerShellInitialization: windowsPowerShellInitialization })
        } catch (error) {
          const definite = error?.nativeCreated === false
          fail(definite ? 'WINDOWS_PTY_UNAVAILABLE' : 'WINDOWS_SPAWN_UNCONFIRMED',
            definite ? 'Windows ConPTY did not create a terminal session.'
              : 'Windows terminal creation could not be confirmed. Do not retry automatically.', 503,
            { transport: 'unavailable', usePty: false, degraded: false, nativeCreated: definite ? false : error?.nativeCreated === true ? true : null })
        }
        return registry.register({ id: sessionId, process: windowsProcess, usePty: true,
          shell: choice.executable, shellId: choice.id, shellLabel: choice.label,
          transport: 'conpty', windowsBuildNumber: windowsBuildNumber(release), ...size })
      }
      let nativeProcess, usePty = true, reason = null
      try {
        const loaded = ptyModule ||= await loadPty()
        const pty = loaded.default || loaded
        if (typeof pty.spawn !== 'function') throw new Error('PTY module has no spawn function')
        nativeProcess = pty.spawn(choice.executable, choice.args, {
          name: 'xterm-256color', ...size, cwd, env: environment,
        })
      } catch (error) {
        usePty = false
        reason = 'PTY_UNAVAILABLE'
        warn('[terminal] native PTY unavailable; starting explicitly limited pipe transport')
        nativeProcess = spawnPipe(choice.executable, choice.args, { cwd, shell: false,
          env: { ...environment, TERM: 'dumb', COLUMNS: String(size.cols), LINES: String(size.rows),
            ZDOTDIR: '/tmp/egdesk-zsh', PS1: '\\n$ ', PROMPT: '\\n$ ' },
          stdio: ['pipe', 'pipe', 'pipe'] })
      }
      return registry.register({ id: sessionId, process: nativeProcess, usePty,
        shell: choice.executable, shellId: choice.id, shellLabel: choice.label,
        transport: usePty ? 'pty' : 'pipe',
        transportReason: reason, ...size })
    },
  }
}
