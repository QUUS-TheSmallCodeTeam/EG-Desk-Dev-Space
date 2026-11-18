// Claude engine status for Settings 'Accounts & AI engines' and the Chat
// header (SUB-08/05, SUB-13): is the Claude CLI installed, which version, and
// is it signed in ('Claude Max · email', 'Anthropic API key', 'not signed in').
//
// Read-only and static. EG-Desk runs only `claude --version` and
// `claude auth status --json` and keeps an allow-list of public fields. It
// never opens the macOS Keychain, ~/.claude credential files or tokens, never
// overrides HOME (that would move the Keychain lookup), and never writes
// Claude settings. D-S1 (b) (2026-10-24): this check gates the runnable Claude
// adapter (claude-engine-adapter.mjs): installed, version range, signed in.
//
// The `auth status --json` mapping is adapted from
// agentclientprotocol/claude-agent-acp src/auth-status.ts:50-52, :88-99,
// :192-289 (Apache-2.0, Copyright Zed Industries). Changes: plain JavaScript,
// an allow-list of output fields, EG-Desk status words, and a `loggedIn: true`
// answer is never shown as signed out.
// Executable search order and the passive-probe environment follow
// steipete/CodexBar Sources/CodexBarCore/PathEnvironment.swift:107-118,
// :375-411 and Providers/Claude/ClaudeCLISession.swift:455-469,
// ClaudeCLIAuthStatusProbe.swift:48-86 (MIT, Copyright (c) 2026 Peter
// Steinberger); the code here is our own.
import { accessSync, constants, realpathSync } from 'node:fs'
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { engineVersionStatus } from './egdesk-native-capabilities.mjs'
import { CLAUDE_TRANSPORT_MIN_VERSION } from './claude-engine-transport.mjs'

// Upper bound on one CLI run, so a hung CLI cannot wedge later probes.
export const CLAUDE_PROBE_TIMEOUT_MS = 5000
// Automatic re-checks (bridge start, /v1/state) at most this often.
export const CLAUDE_STATUS_MAX_AGE_MS = 60_000
// An explicit 'check again' is coalesced inside this window.
export const CLAUDE_STATUS_MIN_INTERVAL_MS = 2000

// No Claude turn has been run against EG-Desk yet (2-E: the CLI on this Mac
// was signed out, so the live round trip was not attempted), so every
// installed version is 'untested'. The minimum is the transport's run gate:
// init.capabilities first appears in 2.1.205 (claude-agent-sdk-python
// types.py:1509-1512); below it the adapter refuses to run, and the row says so.
export const CLAUDE_VERSION_POLICY = Object.freeze({ verified: Object.freeze([]), minimum: CLAUDE_TRANSPORT_MIN_VERSION })

export const CLAUDE_AUTH_STATUSES = Object.freeze(['signedIn', 'signedOut', 'unknown'])
export const CLAUDE_AUTH_METHODS = Object.freeze(['claudeai', 'apiKey', 'gateway', 'external'])

const UNKNOWN_AUTH = Object.freeze({ status: 'unknown', method: null, label: null, account: null, planType: null })
const SIGNED_OUT = Object.freeze({ status: 'signedOut', method: null, label: null, account: null, planType: null })

// Display names for non-firstParty backends, where credentials live outside
// the CLI (AWS, gcloud …). Unknown providers get a generic name, never echoed.
const EXTERNAL_PROVIDER_LABELS = Object.freeze({
  bedrock: 'AWS Bedrock',
  vertex: 'Google Vertex AI',
  foundry: 'Azure AI Foundry',
  anthropicAws: 'Anthropic on AWS',
  anthropicGoogleCloud: 'Anthropic on Google Cloud',
  mantle: 'Mantle',
})

const signal = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 120
const PLAN = /^[A-Za-z][A-Za-z0-9 _.-]{0,39}$/

function publicEmail(value) {
  if (typeof value !== 'string') return null
  const email = value.trim()
  return email.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null
}

function publicPlan(value) {
  if (typeof value !== 'string') return null
  const plan = value.trim()
  return PLAN.test(plan) ? plan : null
}

// One "Claude": a newer CLI reports "Claude Max", an older one "max".
function planLabel(plan) {
  const titled = plan.replace(/\S+/g, word => word.charAt(0).toUpperCase() + word.slice(1))
  return /^claude(\s|$)/i.test(plan) ? titled : `Claude ${titled}`
}

/**
 * `claude auth status --json` stdout → { status, method, label, account,
 * planType }, or null when it is not the expected JSON (unknown, never
 * guessed). The logged-out case exits 1 while still printing valid JSON.
 * Precedence: a gateway or external backend, then an API key (it pays for
 * the turn even beside a subscription login), then the subscription.
 * Paths (configDirectory, projectsDirectory) and other fields are dropped.
 */
export function claudeAuthFromCliStatus(stdout) {
  if (typeof stdout !== 'string' || stdout.length > 65536) return null
  let parsed
  try { parsed = JSON.parse(stdout.trim()) } catch { return null }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  if (typeof parsed.loggedIn !== 'boolean') return null
  const apiProvider = signal(parsed.apiProvider) ? parsed.apiProvider.trim() : null
  if (apiProvider === 'gateway') return { status: 'signedIn', method: 'gateway', label: 'Custom model gateway', account: null, planType: null }
  if (apiProvider && apiProvider !== 'firstParty') {
    const label = Object.hasOwn(EXTERNAL_PROVIDER_LABELS, apiProvider) ? EXTERNAL_PROVIDER_LABELS[apiProvider] : 'External cloud provider'
    return { status: 'signedIn', method: 'external', label, account: null, planType: null }
  }
  if (signal(parsed.apiKeySource)) return { status: 'signedIn', method: 'apiKey', label: 'Anthropic API key', account: null, planType: null }
  if (!parsed.loggedIn) return { ...SIGNED_OUT }
  const account = publicEmail(parsed.email)
  const plan = publicPlan(parsed.subscriptionType)
  if (plan) return { status: 'signedIn', method: 'claudeai', label: planLabel(plan), account, planType: plan }
  return { status: 'signedIn', method: null, label: 'Claude', account, planType: null }
}

// `claude --version` → '2.1.300' from '2.1.300 (Claude Code)'.
export function parseClaudeVersion(stdout) {
  if (typeof stdout !== 'string' || stdout.length > 4096) return null
  const line = stdout.trim().split(/\r?\n/, 1)[0] ?? ''
  return /^(\d{1,9}\.\d{1,9}\.\d{1,9}(?:-[0-9A-Za-z.-]{1,40})?)(?: \(Claude Code\))?$/.exec(line)?.[1] ?? null
}

// Passive probes must not update the user's Claude installation. HOME and
// CLAUDE_CONFIG_DIR pass through unchanged (the CLI's own Keychain lookup).
export function claudeProbeEnvironment(env = process.env) {
  return { ...env, DISABLE_AUTOUPDATER: '1' }
}

function defaultIsExecutable(candidate) {
  try { accessSync(candidate, constants.X_OK); return true } catch { return false }
}

/**
 * EGDESK_CLAUDE_BIN (absolute), else PATH, else the well-known install
 * locations (native installer, migrated local install, Homebrew). Returns the
 * real path or null; the path never leaves the helper.
 */
export function resolveClaudeExecutable(env = process.env, { platform = process.platform, home = os.homedir(), isExecutable = defaultIsExecutable, realpath = realpathSync } = {}) {
  const name = platform === 'win32' ? 'claude.exe' : 'claude'
  const pick = candidate => { try { return isExecutable(candidate) ? realpath(candidate) : null } catch { return null } }
  const override = typeof env.EGDESK_CLAUDE_BIN === 'string' ? env.EGDESK_CLAUDE_BIN.trim() : ''
  if (override) return path.isAbsolute(override) ? pick(override) : null
  const searchPath = env.PATH || env.Path || env.path || ''
  const candidates = searchPath.split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean).map(dir => path.join(dir, name))
  if (typeof home === 'string' && home) {
    candidates.push(path.join(home, '.local', 'bin', name))
    if (platform !== 'win32') candidates.push(path.join(home, '.claude', 'local', name), path.join(home, '.claude', 'bin', name))
  }
  if (platform !== 'win32') candidates.push('/opt/homebrew/bin/claude', '/usr/local/bin/claude')
  for (const candidate of candidates) {
    const found = pick(candidate)
    if (found) return found
  }
  return null
}

/**
 * Runs one CLI command without a shell, stdin closed and stderr discarded.
 * Resolves { status, stdout, timedOut } and never rejects; output above
 * maxBytes or a run past timeoutMs is killed and reported as status null.
 */
export function runBounded(file, args, { env = process.env, cwd = os.tmpdir(), timeoutMs = CLAUDE_PROBE_TIMEOUT_MS, maxBytes = 65536, spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    let child = null, timer = null, stdout = '', size = 0, settled = false, timedOut = false
    const finish = status => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      resolve({ status, stdout: status === null ? '' : stdout, timedOut })
    }
    const stop = () => { try { child?.kill('SIGKILL') } catch {} }
    try { child = spawnImpl(file, args, { env, cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }) }
    catch { finish(null); return }
    timer = setTimeout(() => { timedOut = true; stop(); finish(null) }, timeoutMs)
    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on('data', chunk => {
      if (settled) return
      const text = String(chunk)
      size += Buffer.byteLength(text)
      if (size > maxBytes) { stop(); finish(null); return }
      stdout += text
    })
    child.on('error', () => finish(null))
    child.on('close', code => finish(Number.isInteger(code) ? code : null))
  })
}

/**
 * One static check → { installed, version, versionStatus, auth, checkedAt }.
 * installed false: no executable found. auth.status 'unknown': the CLI did
 * not answer in the expected shape (timeout, old CLI, broken install).
 */
export async function probeClaudeEngine({ env = process.env, cwd = os.tmpdir(), platform = process.platform, home = os.homedir(), resolve = resolveClaudeExecutable, run = runBounded, now = Date.now, timeoutMs = CLAUDE_PROBE_TIMEOUT_MS } = {}) {
  let executable = null
  try { executable = resolve(env, { platform, home }) } catch { executable = null }
  if (typeof executable !== 'string' || !executable) return { installed: false, version: null, versionStatus: null, auth: null, checkedAt: now() }
  const launch = { env: claudeProbeEnvironment(env), cwd, timeoutMs }
  let version = null, auth = null
  try {
    const answer = await run(executable, ['--version'], { ...launch, maxBytes: 4096 })
    version = answer?.status === 0 ? parseClaudeVersion(answer.stdout) : null
  } catch { version = null }
  try {
    // Exit 1 with valid JSON is the logged-out answer, so stdout is read regardless.
    const answer = await run(executable, ['auth', 'status', '--json'], { ...launch, maxBytes: 65536 })
    auth = typeof answer?.stdout === 'string' ? claudeAuthFromCliStatus(answer.stdout) : null
  } catch { auth = null }
  return { installed: true, version, versionStatus: engineVersionStatus(version, CLAUDE_VERSION_POLICY), auth: auth ?? { ...UNKNOWN_AUTH }, checkedAt: now() }
}

// D-S1 login button (SUB-08·12): the screen opens a Terminal card
// (POST /terminal/spawn) and writes `line` + Enter. The CLI's own login keeps
// the credential (Keychain or its config folder); EG-Desk never reads, sees
// or stores it. Afterwards the screen asks POST /engines/claude/refresh.
// Methods are `claude auth login --help` (2.1.300): --claudeai (subscription,
// the default) and --console (Anthropic Console, billed per use: the D-S4 API
// key profile — the key stays with the CLI, never with EG-Desk). Pattern:
// claude-agent-acp src/acp-agent.ts:2903-2941 terminal auth methods
// (Apache-2.0); the code here is our own. `claude` is the PATH name in the
// user's shell, so no executable path leaves the helper.
export const CLAUDE_LOGIN_METHODS = Object.freeze({ claudeai: '--claudeai', console: '--console' })

export function claudeLoginTerminalCommand(method = 'claudeai') {
  const chosen = method ?? 'claudeai'
  if (typeof chosen !== 'string' || !Object.hasOwn(CLAUDE_LOGIN_METHODS, chosen)) {
    throw Object.assign(new Error("Claude login method must be 'claudeai' or 'console'"), { code: 'CLAUDE_LOGIN_METHOD_INVALID', httpStatus: 400 })
  }
  const argv = ['claude', 'auth', 'login', CLAUDE_LOGIN_METHODS[chosen]]
  return {
    method: chosen, billing: chosen === 'console' ? 'apiKey' : 'subscription',
    argv, line: argv.join(' '), credentialStore: 'claude-cli',
    afterward: { method: 'POST', route: '/engines/claude/refresh' },
  }
}

const NOT_CHECKED = Object.freeze({ installed: null, version: null, versionStatus: null, auth: null, checkedAt: null })

/**
 * Holds the last check for the selected profile. refresh() joins a check in
 * the same selection only. A switch drops cached and in-flight evidence;
 * maxAgeMs skips a fresh enough one (automatic checks); force re-checks unless
 * one finished within minIntervalMs ('check again' button). onChange(snapshot)
 * runs only when the public part changed.
 */
export function createClaudeEngineStatus({ probe = () => probeClaudeEngine(), getProfileId = () => 'claude-default', onChange = () => {}, now = Date.now, minIntervalMs = CLAUDE_STATUS_MIN_INTERVAL_MS } = {}) {
  let selection = null
  const active = () => {
    let id = null
    try { const value = getProfileId(); if (typeof value === 'string' && /^claude-[a-z0-9]{1,40}$/.test(value)) id = value } catch {}
    if (!selection || selection.id !== id) selection = { id, current: { ...NOT_CHECKED }, running: null }
    return selection
  }
  const snapshot = () => {
    const { current } = active()
    return { ...current, auth: current.auth ? { ...current.auth } : null }
  }
  const publicPart = snapshot => JSON.stringify({ installed: snapshot.installed, version: snapshot.version, versionStatus: snapshot.versionStatus, auth: snapshot.auth })
  const run = entry => {
    entry.running = (async () => {
      let next
      try { next = await probe(entry.id) } catch { next = { ...NOT_CHECKED, checkedAt: now() } }
      if (active() !== entry) return snapshot() // including A → B → A
      const changed = publicPart(next) !== publicPart(entry.current)
      entry.current = { ...NOT_CHECKED, ...next, checkedAt: Number.isFinite(next?.checkedAt) ? next.checkedAt : now() }
      if (changed) { try { onChange(snapshot()) } catch {} }
      return snapshot()
    })().finally(() => { entry.running = null })
    return entry.running
  }
  return {
    snapshot,
    refresh({ force = false, maxAgeMs = CLAUDE_STATUS_MAX_AGE_MS } = {}) {
      const entry = active()
      if (!entry.id) return Promise.resolve(snapshot())
      if (entry.running) return entry.running
      const age = entry.current.checkedAt === null ? Infinity : now() - entry.current.checkedAt
      if (age < (force ? minIntervalMs : maxAgeMs)) return Promise.resolve(snapshot())
      return run(entry)
    },
  }
}
