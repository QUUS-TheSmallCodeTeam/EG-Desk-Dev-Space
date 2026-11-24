import { suffixBytes, prefixBytes } from './codex-run-outputs.mjs'

// The runner of EG-Desk's own command tool (c18; used by egdesk-command-executor.mjs). Implemented against a process-spawn interface
// spawn(file, args, { cwd, env, stdio, detached }) → child { pid, stdout, stderr, on('close'|'error'), kill(signal) } (node:child_process
// shape); tests use a fake spawn only. It runs only what the executor's approval ledger already let through.
//
//   cwd       the run folder the executor resolved (never the engine's thread folder)
//   shell     /bin/sh -c <command>: not a login shell, so no profile/rc file adds variables
//   env       an ALLOWLIST built from scratch, never the bridge's environment (no API keys, tokens, CODEX_*, EGDESK_* or proxy settings)
//   timeouts  a soft notice (the engine and the facts learn the command is still running) and a hard limit: SIGTERM to the process
//             group, then SIGKILL after a grace period
//   output    head + tail kept for the tool result (bounded); everything also streamed to the run output store (the screen's
//             "command output" view, RunOutputStore, which keeps its own head/tail), so long output spills there instead of the reply
//   facts     started, still running (soft notice), ended with exit code and duration, in the c10 row shape (kind 'engine')
export const COMMAND_RUNNER_LIMITS = Object.freeze({ softNoticeMs: 30_000, timeoutMs: 120_000, killGraceMs: 2_000, headBytes: 4 * 1024, tailBytes: 16 * 1024 })
// What a command gets, and why. Values come from the bridge's own environment only for the first group.
export const COMMAND_ENV_INHERITED = Object.freeze([
  'PATH', // find the tools the person installed (node, git, npm, python)
  'HOME', // tools read their own settings and caches under the person's home (git config, npm cache)
  'USER', 'LOGNAME', // some tools identify the local user
  'LANG', 'LC_ALL', 'LC_CTYPE', // text encoding of the output
  'TMPDIR', // the per-user temporary folder on macOS
  'TZ', // dates in output
])
export const COMMAND_ENV_FIXED = Object.freeze({
  TERM: 'dumb', // no interactive terminal features
  NO_COLOR: '1', // plain output for the model and the facts
  PAGER: 'cat', GIT_PAGER: 'cat', // a pager would wait for a key forever
  GIT_TERMINAL_PROMPT: '0', // git fails instead of waiting for a password nobody can type
  CI: '1', // tools pick non-interactive behaviour
})
export function commandEnvironment(source = {}) {
  const env = {}
  for (const name of COMMAND_ENV_INHERITED) if (typeof source[name] === 'string' && source[name]) env[name] = source[name]
  return { ...env, ...COMMAND_ENV_FIXED }
}

const keep = (state, text, L) => {
  state.total += Buffer.byteLength(text)
  if (!state.headClosed) {
    const part = prefixBytes(text, L.headBytes - Buffer.byteLength(state.head))
    state.head += part
    text = text.slice(part.length)
  }
  if (text) { state.headClosed = true; state.tail = suffixBytes(state.tail + text, L.tailBytes) }
}
const shown = state => ({ text: state.head + (state.tail ? (state.total > Buffer.byteLength(state.head) + Buffer.byteLength(state.tail) ? '\n…\n' : '') + state.tail : ''),
  truncated: state.total > Buffer.byteLength(state.head) + Buffer.byteLength(state.tail) })

/**
 * createCommandRunner({ spawn, env?, killGroup?, now?, setTimer?, clearTimer?, limits? })
 * → runner({ command, cwd, timeoutMs, signal, itemId, output?, onFacts? }) → { exitCode, signal, timedOut, softNotice, durationMs, stdout, stderr, truncated }
 *   output: { append(itemId, text), complete(itemId) }   the run output store adapter (optional)
 */
export function createCommandRunner({ spawn, env = process.env, killGroup = null, now = () => performance.now(), setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = handle => clearTimeout(handle), limits = {} } = {}) {
  if (typeof spawn !== 'function') throw new TypeError('createCommandRunner needs a spawn function')
  const L = { ...COMMAND_RUNNER_LIMITS, ...limits }
  const childEnv = commandEnvironment(env)
  const kill = (child, sig) => {
    try { if (typeof killGroup === 'function') { killGroup(child, sig); return } } catch { /* fall back */ }
    try { child.kill(sig) } catch { /* already gone */ }
  }
  return function run({ command, cwd, timeoutMs = L.timeoutMs, signal = null, itemId = null, output = null, onFacts = () => {} } = {}) {
    return new Promise((resolve, reject) => {
      const began = now()
      const facts = row => { try { onFacts(row) } catch { /* advisory */ } }
      let child
      try { child = spawn('/bin/sh', ['-c', command], { cwd, env: { ...childEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: true }) }
      catch (error) { reject(error); return }
      const out = { head: '', tail: '', total: 0, headClosed: false }, err = { head: '', tail: '', total: 0, headClosed: false }
      let timedOut = false, softNotice = false, done = false, hardTimer = null, graceTimer = null
      const softTimer = setTimer(() => { softNotice = true; facts({ running: true, runningMs: Math.round(now() - began), softNotice: true }) }, Math.min(L.softNoticeMs, timeoutMs))
      hardTimer = setTimer(() => {
        timedOut = true
        kill(child, 'SIGTERM')
        graceTimer = setTimer(() => kill(child, 'SIGKILL'), L.killGraceMs)
      }, timeoutMs)
      const onAbort = () => { timedOut = true; kill(child, 'SIGTERM'); graceTimer = graceTimer ?? setTimer(() => kill(child, 'SIGKILL'), L.killGraceMs) }
      signal?.addEventListener?.('abort', onAbort, { once: true })
      const sink = (state, chunk) => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
        keep(state, text, L)
        try { output?.append?.(itemId, text) } catch { /* the screen view is advisory */ }
      }
      child.stdout?.on?.('data', chunk => sink(out, chunk))
      child.stderr?.on?.('data', chunk => sink(err, chunk))
      facts({ running: true, runningMs: 0 })
      const finish = (exitCode, sig) => {
        if (done) return
        done = true
        for (const timer of [softTimer, hardTimer, graceTimer]) if (timer) clearTimer(timer)
        signal?.removeEventListener?.('abort', onAbort)
        try { output?.complete?.(itemId) } catch { /* advisory */ }
        const durationMs = Math.round(now() - began)
        facts({ running: false, runningMs: durationMs, exitCode: Number.isSafeInteger(exitCode) ? exitCode : null })
        const o = shown(out), e = shown(err)
        resolve({ exitCode: Number.isSafeInteger(exitCode) ? exitCode : null, signal: typeof sig === 'string' ? sig : null, timedOut, softNotice, durationMs,
          stdout: o.text, stderr: e.text, truncated: o.truncated || e.truncated })
      }
      child.on('close', (code, sig) => finish(code, sig))
      child.on('error', () => finish(null, null))
    })
  }
}
