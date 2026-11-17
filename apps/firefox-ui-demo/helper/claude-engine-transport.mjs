// Installed `claude` CLI as a child process over the stdio control channel
// (SUB-09·10·12, decision D-S1 (b) adopted 2026-10-24).
//
// NOT A PUBLIC CLI CONTRACT. The channel used here — `--permission-prompt-tool
// stdio` plus control_request / control_response / control_cancel_request
// lines on stdin/stdout — is what the official Agent SDKs speak to the CLI.
// The flag is hidden: Claude Code 2.1.300 `claude --help` lists only
// `--permission-prompts host|none`, whose text mentions
// `--permission-prompt-tool`, and no option line for it. Evidence this
// module is built on (read 2026-10-24, nothing executed beyond
// `claude --version` / `claude --help`):
//   anthropics/claude-agent-sdk-python @ 0e89b298e771259378a6cd3734e00d323dff5703
//     (2026-10-24; the three files below are byte-identical to that HEAD, last
//     touched by dbc975eb / aada0240)
//     types.py:2281-2304 can_use_tool → permission_prompt_tool_name="stdio";
//     types.py:2797-2901 control request/response shapes; types.py:1509-1512
//     init.capabilities (absent before CLI 2.1.205);
//     _internal/transport/subprocess_cli.py:570-795 argv, :163-221 line
//     framing, :809-899 env and spawn, :962-1061 close order, :1164-1218
//     version probe, :366-448 Windows batch refusal, :54-68 parent-exit reap;
//     _internal/query.py:309-363 initialize, :388-426 routing, :577-704
//     handling, :706-751 outgoing requests, :792-794 interrupt;
//     _internal/client.py:180-196 user message line.
//   BloopAI/vibe-kanban @ d5cbb5380fa0b32e98ef9b8d987f63decce4be3a
//     crates/executors/src/executors/claude.rs:148-193 (direct `claude -p`
//     with `--permission-prompt-tool=stdio`, no npm SDK), :620-647 (key
//     removed from the child env), claude/protocol.rs:23-219 (read loop,
//     control responses, interrupt).
//   pingdotgg/t3code @ 26c3625f484eadd4d5b6ca5a3dd1f8f8bd5533b4
//     apps/server/src/provider/ClaudeProvider.ts:200-240 (disableAllHooks,
//     --strict-mcp-config, ENABLE_CLAUDEAI_MCP_SERVERS=false, IDE env),
//     apps/server/src/provider/Drivers/ClaudeHome.ts:30-65 (keep HOME for the
//     macOS keychain; managed-mcp.json makes the CLI refuse
//     --strict-mcp-config).
//   agentclientprotocol/claude-agent-acp @ ebfbfbdaa9c2a6a8bd9eb0a4965b521009152350
//     src/hide-claude-auth.ts:61-77 and src/auth-status.ts:105-110 (which
//     credentials outrank the subscription), src/acp-agent.ts:11452-11461
//     (settings.json env is applied after the process env).
// Patterns are rewritten here, not copied. Attribution:
//   claude-agent-sdk-python — MIT, Copyright (c) 2025 Anthropic, PBC.
//   t3code — MIT, Copyright (c) 2026 T3 Tools Inc.
//   vibe-kanban, claude-agent-acp — Apache-2.0 (patterns only, no code).
//
// Scope: start one `claude` per conversation, frame its NDJSON stdout, route
// control requests to injected handlers, write user messages and outgoing
// control requests (initialize, interrupt, ...), and stop it without leaving
// orphans. Finding the executable and reading login status belong to
// claude-engine-auth.mjs (1-E); approvals/questions to claude-engine-permissions
// .mjs and EG-Desk tools to egdesk-claude-mcp.mjs (1-C); output translation to
// claude-stream-translate.mjs. This module never reads credential values,
// never logs message bodies, and persists nothing.
//
// D-S2 isolation (defaults): user hooks off (`--settings {"disableAllHooks":true}`),
// only EG-Desk's in-process MCP (`--strict-mcp-config` + an 'sdk' --mcp-config),
// claude.ai connectors off (ENABLE_CLAUDEAI_MCP_SERVERS=false), no settings
// files and so no CLAUDE.md (`--setting-sources=`), skills off
// (`--disable-slash-commands`). Login stays shared: HOME and CLAUDE_CONFIG_DIR
// pass through. D-S4: an API key in the environment stops start() before
// anything runs unless the caller confirmed 'strip' (the key is never handed
// to the child either way). D-S5 is not here (no automatic resume).

import { spawn as nodeSpawn, execFile as nodeExecFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { publicText } from './codex-chat-values.mjs'

/** init.capabilities first appears in CLI 2.1.205 (SDK types.py:1509-1512). */
export const CLAUDE_TRANSPORT_MIN_VERSION = '2.1.205'
/** The CLI whose --help this module's flags were checked against (no turn was run). */
export const CLAUDE_TRANSPORT_CHECKED_VERSION = '2.1.300'

export const CLAUDE_TRANSPORT_LIMITS = Object.freeze({
  maxLineChars: 8 * 1024 * 1024, // one stdout line; same as claude-stream-translate maxLineChars
  maxWriteChars: 16 * 1024 * 1024, // one stdin line (user message with images, tool results)
  maxBufferedWriteChars: 64 * 1024 * 1024, // refuse writes while the CLI is not reading
  maxStderrLineChars: 4000,
  maxPendingIncoming: 512, // egdesk-claude-mcp maxPending
  maxPendingOutgoing: 64,
  maxControlErrorChars: 500,
  maxAppendPromptChars: 200_000,
  maxContentBlocks: 100,
})

export const CLAUDE_TRANSPORT_TIMEOUTS = Object.freeze({
  versionProbeMs: 10_000, // SDK uses 2s; t3code 20s on Windows
  initializeMs: 60_000, // SDK initialize_timeout default
  controlMs: 30_000,
  interruptMs: 10_000,
  closeGraceMs: 10_000, // engine-adapter-design §9: stdin close → 10s → SIGTERM → 5s → SIGKILL
  closeTermMs: 5_000,
  closeKillMs: 2_000,
  exitCloseFallbackMs: 2_000, // 'close' can lag 'exit' when a grandchild holds a pipe
})

/** Environment names that make the CLI bill an API key instead of the subscription. */
export const CLAUDE_API_KEY_ENV_NAMES = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'])

/** apiKeySource values on system/init that mean an API key pays (claude-agent-acp hide-claude-auth.ts). */
export const CLAUDE_API_KEY_SOURCES = Object.freeze(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'apiKeyHelper', '/login managed key'])

/** The only parent variables copied into the child (login, locale, proxy, OS basics). */
export const CLAUDE_ENV_ALLOWLIST = Object.freeze([
  'HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'TZ',
  'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'CLAUDE_CONFIG_DIR',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  // Windows
  'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'APPDATA', 'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'TEMP', 'TMP', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
])

/** Set last on every child env; callers cannot override them (D-S2). */
export const CLAUDE_ISOLATION_ENV = Object.freeze({
  ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
  CLAUDE_CODE_AUTO_CONNECT_IDE: '0',
  CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL: '1',
})

/** The --settings value: user and plugin hooks off (official setting `disableAllHooks`). */
export const CLAUDE_ISOLATION_SETTINGS = Object.freeze({ disableAllHooks: true })

/** `--permission-mode` choices printed by CLI 2.1.300, without bypassPermissions. */
export const CLAUDE_PERMISSION_MODES = Object.freeze(['manual', 'acceptEdits', 'plan', 'dontAsk', 'auto'])
export const CLAUDE_EFFORT_LEVELS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
export const CLAUDE_SYSTEM_PROMPT_SNAPSHOT = Object.freeze(['on', 'off'])

/** Requests the CLI sends us (SDK query.py:586-677); others can be handled by name too. */
export const CLAUDE_INCOMING_CONTROL_SUBTYPES = Object.freeze(['can_use_tool', 'hook_callback', 'mcp_message'])
/** Requests we may send (SDK query.py:340-363, :784-812). */
export const CLAUDE_OUTGOING_CONTROL_SUBTYPES = Object.freeze(['initialize', 'interrupt', 'set_permission_mode', 'set_model', 'mcp_status', 'get_context_usage'])

/**
 * Every flag buildClaudeArgs can emit and where it was checked. A flag without
 * an entry here must not be emitted (the flag-list test enforces it).
 */
export const CLAUDE_FLAG_SOURCES = Object.freeze({
  '-p': 'claude 2.1.300 --help (-p, --print); vibe-kanban claude.rs:157-158',
  '--output-format': 'claude 2.1.300 --help; SDK subprocess_cli.py:574',
  '--input-format': 'claude 2.1.300 --help; SDK subprocess_cli.py:791-793',
  '--verbose': 'claude 2.1.300 --help; SDK subprocess_cli.py:574',
  '--permission-prompt-tool': 'hidden in claude 2.1.300 --help (named only inside --permission-prompts); SDK types.py:2281-2304, subprocess_cli.py:631-634',
  '--settings': 'claude 2.1.300 --help; t3code ClaudeProvider.ts:220-221 (disableAllHooks)',
  '--setting-sources': 'claude 2.1.300 --help; SDK types.py:2653-2663 ([] = isolation), subprocess_cli.py:729-730',
  '--strict-mcp-config': 'claude 2.1.300 --help; SDK subprocess_cli.py:700-701',
  '--mcp-config': 'claude 2.1.300 --help; SDK subprocess_cli.py:667-689 (type sdk)',
  '--disable-slash-commands': 'claude 2.1.300 --help ("Disable all skills")',
  '--include-partial-messages': 'claude 2.1.300 --help; SDK subprocess_cli.py:694-695',
  '--model': 'claude 2.1.300 --help',
  '--effort': 'claude 2.1.300 --help (low, medium, high, xhigh, max)',
  '--permission-mode': 'claude 2.1.300 --help (choices)',
  '--append-system-prompt': 'claude 2.1.300 --help; SDK subprocess_cli.py:586-589',
  '--session-id': 'claude 2.1.300 --help; SDK subprocess_cli.py:651-655 (equals form)',
  '--resume': 'claude 2.1.300 --help; SDK subprocess_cli.py:642-649 (equals form)',
  '--allowedTools': 'claude 2.1.300 --help; SDK subprocess_cli.py:607-608',
  '--disallowedTools': 'claude 2.1.300 --help; SDK subprocess_cli.py:616-617',
  '--add-dir': 'claude 2.1.300 --help; SDK subprocess_cli.py:662-665',
  '--tools': 'claude 2.1.300 --help (\'Use "" to disable all tools\')',
  '--system-prompt-snapshot': 'claude 2.1.300 --help (on|off; off renders the prompt fresh every request)',
  '--system-prompt': 'official SDK python @ 0e89b298e771259378a6cd3734e00d323dff5703 subprocess_cli.py _build_command; https://code.claude.com/docs/en/cli-reference (2026-10-25)',
  '--max-turns': 'same pinned SDK _build_command; official CLI reference (2026-10-25): per-message agentic turn ceiling in stream-json mode',
  '--no-session-persistence': 'https://code.claude.com/docs/en/cli-reference (2026-10-25): print-only, no saved/resumable session',
  '--restricted': 'official CLI reference (2026-10-25): >=2.1.248; no command tools or user/project settings; NOT an OS sandbox',
  '--safe-mode': 'official CLI reference (2026-10-25): customizations off, auth retained; managed hooks can still apply',
  '--no-chrome': 'official CLI reference (2026-10-25): disables Chrome integration',
})

const MANAGED_MCP_PATHS = Object.freeze({
  darwin: '/Library/Application Support/ClaudeCode/managed-mcp.json',
  win32: 'C:\\Program Files\\ClaudeCode\\managed-mcp.json',
  other: '/etc/claude-code/managed-mcp.json',
})
const OVERSIZE_PREFIX_CHARS = 512
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@/[\]-]{0,127}$/
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
const SUBTYPE = /^[A-Za-z0-9_][A-Za-z0-9_.:/-]{0,63}$/
// A rule like `mcp__egdesk` or `Bash(git status:*)`; commas split rules, so none inside one.
const TOOL_RULE = /^[A-Za-z_][^,\0-\x1f\x7f]{0,299}$/
// A built-in tool name for --tools (`Read`, `Bash`, ...); no rule syntax.
const BUILTIN_TOOL = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const DENIED_ENV = new Set(['CLAUDECODE']) // SDK filters it so the child does not think it runs inside Claude Code (#573)

const plainObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null
const idText = value => typeof value === 'string' && value.length > 0 && value.length <= 300 ? value : null
const subtypeToken = value => typeof value === 'string' && SUBTYPE.test(value) ? value : null
const errorText = (value, limit = CLAUDE_TRANSPORT_LIMITS.maxControlErrorChars) =>
  publicText(typeof value === 'string' && value ? value : 'error', limit) || 'error'

function transportError(code, message, fields = {}) {
  return Object.assign(new Error(message), { code, ...fields })
}

function optionError(message) {
  return transportError('CLAUDE_OPTION_INVALID', message)
}

function isAbsoluteFor(platform, candidate) {
  return platform === 'win32' ? path.win32.isAbsolute(candidate) : path.posix.isAbsolute(candidate)
}

function absolutePath(value, name, platform) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || !isAbsoluteFor(platform, value)) {
    throw optionError(`${name} must be an absolute path`)
  }
  return value
}

/**
 * True when any path component names a .bat/.cmd script. Windows runs those
 * through cmd.exe, which re-parses arguments (CVE-2024-27980, "BatBadBut");
 * every component is checked, stream specs (`a.cmd:x`) included, after
 * trimming the trailing dots/spaces Windows strips (SDK subprocess_cli.py:366-412).
 */
export function isWindowsBatchPath(candidate) {
  if (typeof candidate !== 'string') return false
  return candidate.replace(/\\/g, '/').split('/').some(component =>
    component.split(':').some(segment => /\.(bat|cmd)$/i.test(segment.replace(/[. ]+$/, ''))))
}

/** `2.1.300 (Claude Code)` → '2.1.300'; anything else → null. */
export function parseClaudeVersion(text) {
  if (typeof text !== 'string') return null
  const match = /^\s*v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?![\d])/.exec(text)
  return match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : null
}

/** -1 / 0 / 1 for two 'x.y.z' strings (prerelease suffixes are not compared). */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number)
  const pb = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0) ? -1 : 1
  }
  return 0
}

/** Version gate: { ok, version, minVersion, code? }. */
export function checkClaudeVersion(text, minVersion = CLAUDE_TRANSPORT_MIN_VERSION) {
  const version = parseClaudeVersion(text)
  if (!version) return { ok: false, version: null, minVersion, code: 'CLAUDE_VERSION_UNKNOWN' }
  if (compareVersions(version, minVersion) < 0) return { ok: false, version, minVersion, code: 'CLAUDE_VERSION_UNSUPPORTED' }
  return { ok: true, version, minVersion }
}

function envKeyFinder(env, platform) {
  const keys = Object.keys(env || {})
  if (platform !== 'win32') {
    const present = new Set(keys)
    return name => (present.has(name) ? name : null)
  }
  const byUpper = new Map()
  for (const key of keys) if (!byUpper.has(key.toUpperCase())) byUpper.set(key.toUpperCase(), key)
  return name => byUpper.get(name.toUpperCase()) ?? null
}

/**
 * Names of API key variables present in `env`. Only key names are looked at;
 * no value is read, so a set-but-empty variable also counts (asking once more
 * is the safe side of D-S4).
 */
export function detectApiKeyEnv(env = process.env, { platform = process.platform } = {}) {
  const find = envKeyFinder(env, platform)
  return CLAUDE_API_KEY_ENV_NAMES.filter(name => find(name) !== null)
}

/**
 * The child environment: allowlisted parent variables, optional extra names
 * the caller wants copied, EG-Desk's own variables, then the isolation
 * variables. API key variables and CLAUDECODE are never copied.
 */
export function buildClaudeEnv(parentEnv = process.env, {
  platform = process.platform, cwd = null, claudeConfigDir = null, inheritEnvNames = [], extraEnv = {},
} = {}) {
  const find = envKeyFinder(parentEnv, platform)
  const refused = name => CLAUDE_API_KEY_ENV_NAMES.some(key => key.toUpperCase() === name.toUpperCase()) || DENIED_ENV.has(name.toUpperCase())
  const child = {}
  const copy = name => {
    if (refused(name)) return
    const key = find(name)
    if (key !== null && typeof parentEnv[key] === 'string') child[key] = parentEnv[key]
  }
  for (const name of CLAUDE_ENV_ALLOWLIST) copy(name)
  if (!Array.isArray(inheritEnvNames)) throw optionError('inheritEnvNames must be an array')
  for (const name of inheritEnvNames) {
    if (typeof name !== 'string' || !ENV_NAME.test(name)) throw optionError('inheritEnvNames entries must be variable names')
    if (refused(name)) throw optionError(`${name} cannot be passed to Claude`)
    copy(name)
  }
  const extras = plainObject(extraEnv)
  if (extraEnv != null && !extras) throw optionError('extraEnv must be an object')
  for (const [name, value] of Object.entries(extras || {})) {
    if (!ENV_NAME.test(name)) throw optionError('extraEnv names must be variable names')
    if (refused(name)) throw optionError(`${name} cannot be passed to Claude`)
    if (typeof value !== 'string' || value.length > 4096 || value.includes('\0')) throw optionError(`extraEnv ${name} must be a short string`)
    child[name] = value
  }
  if (claudeConfigDir != null) child.CLAUDE_CONFIG_DIR = absolutePath(claudeConfigDir, 'claudeConfigDir', platform)
  if (cwd != null) child.PWD = absolutePath(cwd, 'cwd', platform)
  Object.assign(child, CLAUDE_ISOLATION_ENV)
  return child
}

function normalizeMcpConfig(value) {
  if (value == null) return null
  const servers = plainObject(plainObject(value)?.mcpServers)
  if (!servers) throw optionError('mcpConfig must be { mcpServers: { name: { type: "sdk", name } } }')
  const entries = Object.entries(servers)
  if (entries.length > 8) throw optionError('mcpConfig has too many servers')
  const out = {}
  for (const [name, config] of entries) {
    // D-S2: only EG-Desk's in-process servers; no command, URL or user server.
    if (!SERVER_NAME.test(name) || plainObject(config)?.type !== 'sdk' || config.name !== name) {
      throw optionError('mcpConfig servers must be in-process EG-Desk servers ({ type: "sdk", name })')
    }
    out[name] = { type: 'sdk', name }
  }
  return entries.length ? { mcpServers: out } : null
}

function toolRules(value, name) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > 200) throw optionError(`${name} must be an array of tool rules`)
  return value.map(rule => {
    if (typeof rule !== 'string' || !TOOL_RULE.test(rule)) throw optionError(`${name} has an invalid rule`)
    return rule
  })
}

/**
 * The argv after the executable. Pure; throws CLAUDE_OPTION_INVALID.
 *   inherit.instructions — load user/project/local settings (CLAUDE.md comes
 *     with the 'project' source; CLI 2.1.300 has no separate switch).
 *   inherit.skills — keep skills (needs the user and project sources).
 *   managedMcpConfig — a managed-mcp.json exists: the CLI refuses
 *     --strict-mcp-config next to it (t3code ClaudeHome.ts:49-65).
 *   tools — null keeps the CLI's built-in set; [] disables every built-in
 *     tool (`--tools ""`); names limit it (`--tools Read,Grep`).
 *   systemPromptSnapshot — 'on' | 'off' (null: the CLI default). 'off' lets
 *     a resumed conversation pick up changed --append-system-prompt text.
 */
export function buildClaudeArgs({
  mcpConfig = null, managedMcpConfig = false, inherit = {}, includePartialMessages = true,
  model = null, effort = null, permissionMode = null, appendPrompt = null,
  sessionId = null, resume = null, allowedTools = null, disallowedTools = null, addDirs = null,
  tools = null, systemPromptSnapshot = null, readerIsolation = false, systemPrompt = null,
  bounded = false, platform = process.platform,
} = {}) {
  const inheritance = plainObject(inherit) || {}
  const instructions = inheritance.instructions === true
  const skills = inheritance.skills === true
  const sources = instructions ? ['user', 'project', 'local'] : skills ? ['user', 'project'] : []
  const mcp = normalizeMcpConfig(mcpConfig)

  // This is deliberately separate from chat's empty dynamicTools catalog:
  // that catalog does NOT disable built-in tools. Reader callers must also
  // establish managed-policy safety before spawn (safe-mode cannot do that).
  if (readerIsolation) {
    if (managedMcpConfig) throw transportError('READER_ISOLATION_UNAVAILABLE', 'Managed MCP configuration cannot be relaxed for a Reader')
    if (instructions || skills || mcp || resume != null || appendPrompt != null ||
        (tools != null && (!Array.isArray(tools) || tools.length)) ||
        (allowedTools != null && (!Array.isArray(allowedTools) || allowedTools.length)) ||
        (addDirs != null && (!Array.isArray(addDirs) || addDirs.length))) {
      throw optionError('Reader isolation cannot inherit tools, settings, directories or history')
    }
    if (typeof systemPrompt !== 'string' || !systemPrompt || systemPrompt.length > CLAUDE_TRANSPORT_LIMITS.maxAppendPromptChars || systemPrompt.includes('\0')) {
      throw optionError('Reader isolation requires a bounded replacement system prompt')
    }
    tools = []
    permissionMode = 'dontAsk'
    includePartialMessages = false
    disallowedTools = ['mcp__*']
  } else if (systemPrompt != null) throw optionError('A replacement system prompt is only supported for the isolated Reader')
  // SUB-10 browserBounded conversation (egdesk-claude-bounded): no built-in
  // tool, nothing asked, only EG-Desk's MCP. Never relaxed by managed MCP.
  if (bounded) {
    if (readerIsolation) throw optionError('A Reader is not a bounded conversation')
    if (managedMcpConfig) throw transportError('CLAUDE_BOUNDED_UNAVAILABLE', 'Managed MCP configuration cannot be bounded to EG-Desk tools')
    if (!Array.isArray(tools) || tools.length || permissionMode !== 'dontAsk' || instructions || skills) {
      throw optionError('A bounded conversation has no built-in tools, uses dontAsk and inherits no settings')
    }
  }

  const args = [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--permission-prompt-tool', 'stdio',
    '--settings', JSON.stringify(CLAUDE_ISOLATION_SETTINGS),
    `--setting-sources=${sources.join(',')}`,
  ]
  if (!managedMcpConfig) args.push('--strict-mcp-config')
  if (mcp) args.push('--mcp-config', JSON.stringify(mcp))
  if (!skills) args.push('--disable-slash-commands')
  if (includePartialMessages !== false) args.push('--include-partial-messages')
  if (bounded) args.push('--restricted', '--no-chrome')
  if (readerIsolation) args.push(
    '--mcp-config', '{"mcpServers":{}}', '--restricted', '--safe-mode', '--no-chrome',
    '--no-session-persistence', '--max-turns', '1', `--system-prompt=${systemPrompt}`,
  )

  if (model != null) {
    if (typeof model !== 'string' || !MODEL.test(model)) throw optionError('model must be a model id or alias')
    args.push('--model', model)
  }
  if (effort != null) {
    if (!CLAUDE_EFFORT_LEVELS.includes(effort)) throw optionError(`effort must be one of ${CLAUDE_EFFORT_LEVELS.join(', ')}`)
    args.push('--effort', effort)
  }
  if (permissionMode != null) {
    if (!CLAUDE_PERMISSION_MODES.includes(permissionMode)) throw optionError(`permissionMode must be one of ${CLAUDE_PERMISSION_MODES.join(', ')}`)
    args.push('--permission-mode', permissionMode)
  }
  if (appendPrompt != null) {
    if (typeof appendPrompt !== 'string' || !appendPrompt || appendPrompt.length > CLAUDE_TRANSPORT_LIMITS.maxAppendPromptChars || appendPrompt.includes('\0')) {
      throw optionError('appendPrompt must be a non-empty string')
    }
    // Equals form: a value starting with '-' can never be read as a flag.
    args.push(`--append-system-prompt=${appendPrompt}`)
  }
  if (sessionId != null && resume != null) throw optionError('sessionId and resume cannot both be set')
  if (sessionId != null) {
    if (typeof sessionId !== 'string' || !UUID.test(sessionId)) throw optionError('sessionId must be a UUID')
    args.push(`--session-id=${sessionId}`)
  }
  if (resume != null) {
    if (typeof resume !== 'string' || !UUID.test(resume)) throw optionError('resume must be a session UUID')
    args.push(`--resume=${resume}`)
  }
  const allowed = toolRules(allowedTools, 'allowedTools')
  if (allowed.length) args.push('--allowedTools', allowed.join(','))
  const disallowed = toolRules(disallowedTools, 'disallowedTools')
  if (disallowed.length) args.push('--disallowedTools', disallowed.join(','))
  if (addDirs != null) {
    if (!Array.isArray(addDirs) || addDirs.length > 32) throw optionError('addDirs must be an array of absolute paths')
    for (const dir of addDirs) args.push('--add-dir', absolutePath(dir, 'addDirs entry', platform))
  }
  if (tools != null) {
    if (!Array.isArray(tools) || tools.length > 64 || tools.some(name => typeof name !== 'string' || !BUILTIN_TOOL.test(name))) {
      throw optionError('tools must be an array of built-in tool names ([] disables all)')
    }
    // One value: '' (none) or a comma list; the next argv item is a flag, so the variadic option stops here.
    args.push('--tools', tools.join(','))
  }
  if (systemPromptSnapshot != null) {
    if (!CLAUDE_SYSTEM_PROMPT_SNAPSHOT.includes(systemPromptSnapshot)) throw optionError("systemPromptSnapshot must be 'on' or 'off'")
    args.push(`--system-prompt-snapshot=${systemPromptSnapshot}`)
  }
  return args
}

/** Flag names (no values) in an argv from buildClaudeArgs. */
export function claudeArgFlags(args) {
  return args.filter(arg => arg.startsWith('-')).map(arg => arg.split('=')[0])
}

export function managedMcpConfigPath(platform = process.platform) {
  return MANAGED_MCP_PATHS[platform] || MANAGED_MCP_PATHS.other
}

/**
 * Reassembles lines from arbitrary text chunks (SDK subprocess_cli.py:163-196).
 * A line longer than maxLineChars is dropped: onOversized(prefix) is called
 * once with its first 512 chars and the rest is skipped up to the next newline.
 */
export function createLineFramer({ maxLineChars = CLAUDE_TRANSPORT_LIMITS.maxLineChars, onLine, onOversized = () => {} } = {}) {
  if (typeof onLine !== 'function') throw new TypeError('createLineFramer requires onLine')
  let parts = []
  let length = 0
  let head = ''
  let discarding = false
  const reset = () => { parts = []; length = 0; head = '' }
  return {
    push(chunk) {
      const text = typeof chunk === 'string' ? chunk : String(chunk)
      let start = 0
      for (;;) {
        const newline = text.indexOf('\n', start)
        const piece = text.slice(start, newline === -1 ? text.length : newline)
        if (!discarding) {
          if (length + piece.length > maxLineChars) {
            const prefix = (head + piece.slice(0, OVERSIZE_PREFIX_CHARS)).slice(0, OVERSIZE_PREFIX_CHARS)
            reset()
            discarding = true
            onOversized(prefix)
          } else if (piece) {
            parts.push(piece)
            length += piece.length
            if (head.length < OVERSIZE_PREFIX_CHARS) head += piece.slice(0, OVERSIZE_PREFIX_CHARS - head.length)
          }
        }
        if (newline === -1) return
        if (discarding) discarding = false
        else { const line = parts.join(''); reset(); onLine(line) }
        start = newline + 1
      }
    },
    /** The unterminated tail, if any (a truncated oversized line yields ''). */
    flush() {
      const line = discarding ? '' : parts.join('')
      discarding = false
      reset()
      return line
    },
    pendingChars: () => length,
  }
}

// Live children, so a helper that exits without closing a transport does not
// leave `claude` running (SDK subprocess_cli.py:54-68). A child whose parent
// dies outright also sees stdin EOF and exits on its own.
const ACTIVE = new Map() // child → kill(signal)
let reaperInstalled = false
function installReaper() {
  if (reaperInstalled) return
  reaperInstalled = true
  process.once('exit', () => reapClaudeChildren('SIGTERM'))
}

/** Signals every live transport child; returns how many were signalled. */
export function reapClaudeChildren(signal = 'SIGTERM') {
  let count = 0
  for (const kill of ACTIVE.values()) {
    try { kill(signal); count++ } catch {}
  }
  ACTIVE.clear()
  return count
}

export function activeClaudeChildCount() {
  return ACTIVE.size
}

/**
 * createClaudeTransport(options) — one `claude` process for one conversation.
 *
 * options
 *   executablePath (required)  absolute path resolved by claude-engine-auth (1-E); never searched here
 *   cwd                        absolute working directory (default: helper cwd)
 *   version                    `claude --version` text already probed by 1-E (else probed here)
 *   minVersion, requiredCapabilities[]   gates (version before spawn, init.capabilities on system/init)
 *   apiKeyEnvPolicy            'stop' (default: start() rejects CLAUDE_API_KEY_DETECTED) | 'strip' (user confirmed: run on the subscription)
 *   env, platform              parent environment / platform (tests)
 *   argv options               mcpConfig, inherit {instructions, skills}, model, effort, permissionMode,
 *                              appendPrompt, sessionId | resume, allowedTools, disallowedTools, addDirs, includePartialMessages,
 *                              tools, systemPromptSnapshot
 *   managedMcpConfig           true/false, or null to check the managed-mcp.json path
 *   claudeConfigDir, inheritEnvNames[], extraEnv{}   env additions (API key names refused)
 *   initialize                 true (default) | false | { agents?, forwardSubagentText?, excludeDynamicSections? }
 *   controlHandlers            { can_use_tool, hook_callback, mcp_message, <other subtype> }:
 *                                (request, { requestId, subtype, signal }) → result | Promise<result>
 *                              result { response } | { error } | { write: control_response } is written now;
 *                              anything else (undefined, {}, { serverRequest }) waits for respondControl().
 *                              A throw becomes an error response. No handler → "Unsupported control request subtype".
 *   onMessage(msg)             every non-control stdout object (system/init included) → claude-stream-translate
 *   onControlCancel(requestId, subtype, reason)  'cancelled' (control_cancel_request) | 'exit'
 *   onNotice({ code, fatal })  CLAUDE_LINE_TOO_LONG, CLAUDE_STREAM_INVALID_JSON, CLAUDE_MANAGED_MCP_CONFIG,
 *                              CLAUDE_CAPABILITIES_MISSING / CLAUDE_CAPABILITY_MISSING / CLAUDE_VERSION_UNSUPPORTED (fatal)
 *   onStderr(line)             redacted, ≤4000 chars per line (default: dropped)
 *   onExit({ code, signal, reason })  reason 'closed' | 'gate' | 'exited'
 *   limits, timeouts, spawnImpl, execFileImpl, existsImpl, processGroup   (tests / tuning)
 *
 * returns { start, sendUserMessage, interrupt, setPermissionMode, setModel, request,
 *           respondControl, endInput, close, state, info, stats }
 */
export function createClaudeTransport(options = {}) {
  const {
    executablePath, cwd = null, version = null,
    minVersion = CLAUDE_TRANSPORT_MIN_VERSION, requiredCapabilities = [],
    apiKeyEnvPolicy = 'stop', env = process.env, platform = process.platform,
    managedMcpConfig = null, claudeConfigDir = null, inheritEnvNames = [], extraEnv = {},
    initialize = true, controlHandlers = {},
    onMessage = null, onControlCancel = null, onNotice = null, onStderr = null, onExit = null,
    limits = {}, timeouts = {},
    spawnImpl = nodeSpawn, execFileImpl = nodeExecFile, existsImpl = existsSync,
  } = options
  const L = { ...CLAUDE_TRANSPORT_LIMITS, ...limits }
  const T = { ...CLAUDE_TRANSPORT_TIMEOUTS, ...timeouts }
  if (!['stop', 'strip'].includes(apiKeyEnvPolicy)) throw optionError("apiKeyEnvPolicy must be 'stop' or 'strip'")
  if (!Array.isArray(requiredCapabilities) || requiredCapabilities.some(c => typeof c !== 'string' || !SUBTYPE.test(c))) {
    throw optionError('requiredCapabilities must be an array of capability names')
  }
  const handlers = new Map()
  for (const [subtype, fn] of Object.entries(plainObject(controlHandlers) || {})) {
    if (!SUBTYPE.test(subtype) || typeof fn !== 'function') throw optionError('controlHandlers must map subtypes to functions')
    handlers.set(subtype, fn)
  }
  // Group kill reaches the CLI's own children (Bash tool commands) too; only
  // for a real POSIX spawn, where the child leads its own process group.
  const processGroup = options.processGroup ?? (spawnImpl === nodeSpawn && platform !== 'win32')

  let state = 'idle' // idle → starting → running → closing → exited
  let child = null
  let stdinWritable = false
  let initialized = false
  let probedVersion = null
  let initInfo = null
  let gateError = null
  let closeRequested = false
  let closePromise = null
  let exitInfo = null
  let finalized = false
  let exitFallbackTimer = null
  let managed = false
  let resolveFinalized
  const finalizedPromise = new Promise(resolve => { resolveFinalized = resolve })
  const exitWaiters = new Set()
  const incoming = new Map() // control request_id → { subtype, abort }
  const outgoing = new Map() // our request_id → { resolve, reject, timer, subtype }
  let requestCounter = 0
  const stats = {
    lines: 0, blank: 0, nonJson: 0, invalidJson: 0, oversized: 0, notMessage: 0, messages: 0, droppedAfterGate: 0,
    controlRequests: 0, invalidControl: 0, duplicateControl: 0, unsupportedControl: 0, controlCancels: 0,
    unmatchedCancels: 0, lateResponses: 0, controlResponses: 0, unmatchedResponses: 0,
    writes: 0, writeFailures: 0, stderrLines: 0, handlerErrors: 0,
  }

  const safeCall = (fn, ...args) => {
    if (typeof fn !== 'function') return
    try { fn(...args) } catch { stats.handlerErrors++ }
  }
  const notice = (code, fatal, fields = {}) => safeCall(onNotice, { code, fatal, ...fields })

  function killChild(signal) {
    if (!child) return
    if (processGroup && Number.isInteger(child.pid) && child.pid > 0) {
      try { process.kill(-child.pid, signal); return } catch {}
    }
    try { child.kill(signal) } catch {}
  }

  function writeLine(object) {
    if (!child || !stdinWritable || finalized) { stats.writeFailures++; return false }
    const line = JSON.stringify(object) + '\n'
    if (line.length > L.maxWriteChars) throw transportError('CLAUDE_WRITE_TOO_LARGE', 'Message is too large for Claude')
    if ((child.stdin.writableLength || 0) > L.maxBufferedWriteChars) throw transportError('CLAUDE_WRITE_BACKPRESSURE', 'Claude is not reading its input')
    try { child.stdin.write(line) } catch { stats.writeFailures++; return false }
    stats.writes++
    return true
  }

  const controlSuccess = (requestId, response) => ({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
  const controlError = (requestId, message) => ({ type: 'control_response', response: { subtype: 'error', request_id: requestId, error: errorText(message) } })

  // ── incoming control requests (CLI → EG-Desk)
  function respondControl(requestId, result) {
    const entry = incoming.get(requestId)
    if (!entry) { stats.lateResponses++; return false }
    const value = plainObject(result)
    let line
    if (value && plainObject(value.write)) {
      const write = value.write
      if (write.type !== 'control_response' || plainObject(write.response)?.request_id !== requestId) {
        throw new TypeError('respondControl write must be the control_response for this request')
      }
      line = write
    } else if (value && Object.hasOwn(value, 'error')) line = controlError(requestId, value.error)
    else if (value && Object.hasOwn(value, 'response')) line = controlSuccess(requestId, plainObject(value.response) || {})
    else throw new TypeError('respondControl needs { response } | { error } | { write }')
    // A throw (line too large, backpressure) keeps the entry, so the caller can still answer with an error.
    const written = writeLine(line)
    incoming.delete(requestId)
    return written
  }

  const isAnswer = value => {
    const v = plainObject(value)
    return Boolean(v && (plainObject(v.write) || Object.hasOwn(v, 'response') || Object.hasOwn(v, 'error')))
  }

  function handleControlRequest(msg) {
    stats.controlRequests++
    const requestId = idText(msg.request_id)
    const request = plainObject(msg.request)
    const subtype = subtypeToken(request?.subtype)
    if (!requestId || !subtype) { stats.invalidControl++; return }
    if (incoming.has(requestId)) { stats.duplicateControl++; return }
    if (incoming.size >= L.maxPendingIncoming) { writeLine(controlError(requestId, 'Too many pending control requests')); return }
    const handler = handlers.get(subtype)
    if (!handler) {
      stats.unsupportedControl++
      writeLine(controlError(requestId, `Unsupported control request subtype: ${subtype}`))
      notice('CLAUDE_UNSUPPORTED_CONTROL', false)
      return
    }
    const abort = new AbortController()
    incoming.set(requestId, { subtype, abort })
    Promise.resolve()
      .then(() => handler(request, { requestId, subtype, signal: abort.signal }))
      .then(value => { if (isAnswer(value) && incoming.has(requestId)) respondControl(requestId, value) })
      .catch(error => {
        stats.handlerErrors++
        if (incoming.has(requestId)) {
          try { respondControl(requestId, { error: error?.message || 'EG-Desk could not answer this request' }) } catch {}
        }
      })
  }

  function handleControlCancel(msg) {
    const requestId = idText(msg.request_id)
    const entry = requestId && incoming.get(requestId)
    if (!entry) { stats.unmatchedCancels++; return }
    // The CLI has abandoned it: no response is written for it (SDK query.py:690-693).
    incoming.delete(requestId)
    stats.controlCancels++
    entry.abort.abort()
    safeCall(onControlCancel, requestId, entry.subtype, 'cancelled')
  }

  // ── outgoing control requests (EG-Desk → CLI)
  function handleControlResponse(msg) {
    stats.controlResponses++
    const response = plainObject(msg.response)
    const requestId = idText(response?.request_id)
    const entry = requestId && outgoing.get(requestId)
    if (!entry) { stats.unmatchedResponses++; return }
    outgoing.delete(requestId)
    clearTimeout(entry.timer)
    if (response.subtype === 'success') entry.resolve(plainObject(response.response) || {})
    else entry.reject(transportError('CLAUDE_CONTROL_ERROR', errorText(response.error), { subtype: entry.subtype }))
  }

  function request(subtype, fields = {}, { timeoutMs = T.controlMs } = {}) {
    if (!CLAUDE_OUTGOING_CONTROL_SUBTYPES.includes(subtype)) return Promise.reject(optionError(`Unsupported outgoing control request: ${subtype}`))
    if (state !== 'running') return Promise.reject(transportError('CLAUDE_TRANSPORT_STATE', 'Claude is not running'))
    if (outgoing.size >= L.maxPendingOutgoing) return Promise.reject(transportError('CLAUDE_TRANSPORT_BUSY', 'Too many Claude control requests in flight'))
    const requestId = `req_${++requestCounter}_${randomBytes(4).toString('hex')}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        outgoing.delete(requestId)
        reject(transportError('CLAUDE_CONTROL_TIMEOUT', `${subtype} timed out`, { subtype }))
      }, timeoutMs)
      timer.unref?.()
      outgoing.set(requestId, { resolve, reject, timer, subtype })
      let written = false
      try {
        written = writeLine({ type: 'control_request', request_id: requestId, request: { ...(plainObject(fields) || {}), subtype } })
      } catch (error) {
        clearTimeout(timer)
        outgoing.delete(requestId)
        reject(error)
        return
      }
      if (!written) {
        clearTimeout(timer)
        outgoing.delete(requestId)
        reject(transportError('CLAUDE_TRANSPORT_CLOSED', 'Claude input is closed'))
      }
    })
  }

  function rejectOutgoing(error) {
    for (const entry of outgoing.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    outgoing.clear()
  }

  // ── system/init gate (init.capabilities, version drift after an auto-update)
  function gateInit(msg) {
    const capabilities = Array.isArray(msg.capabilities) ? msg.capabilities.filter(c => typeof c === 'string' && SUBTYPE.test(c)).slice(0, 64) : null
    const reported = parseClaudeVersion(typeof msg.claude_code_version === 'string' ? msg.claude_code_version : '')
    const source = typeof msg.apiKeySource === 'string' ? msg.apiKeySource.slice(0, 64) : null
    initInfo = {
      version: reported, capabilities: capabilities || [],
      billsApiKey: source !== null && CLAUDE_API_KEY_SOURCES.includes(source),
    }
    if (reported && compareVersions(reported, minVersion) < 0) {
      return transportError('CLAUDE_VERSION_UNSUPPORTED', `Claude ${reported} is older than ${minVersion}`, { version: reported, minVersion })
    }
    if (!capabilities) return transportError('CLAUDE_CAPABILITIES_MISSING', 'Claude did not report its capabilities')
    const missing = requiredCapabilities.filter(c => !capabilities.includes(c))
    if (missing.length) return transportError('CLAUDE_CAPABILITY_MISSING', 'Claude lacks a required capability', { missing })
    return null
  }

  function handleLine(line) {
    stats.lines++
    const text = line.trim()
    if (!text) { stats.blank++; return }
    // Some builds print non-JSON debug lines to stdout (SDK #347).
    if (text[0] !== '{') { stats.nonJson++; return }
    let msg
    try { msg = JSON.parse(text) } catch {
      stats.invalidJson++
      notice('CLAUDE_STREAM_INVALID_JSON', false)
      return
    }
    if (!plainObject(msg) || typeof msg.type !== 'string') { stats.notMessage++; return }
    if (msg.type === 'control_request') return handleControlRequest(msg)
    if (msg.type === 'control_response') return handleControlResponse(msg)
    if (msg.type === 'control_cancel_request') return handleControlCancel(msg)
    if (msg.type === 'system' && msg.subtype === 'init' && initInfo === null) {
      const failure = gateInit(msg)
      if (failure) {
        gateError = failure
        notice(failure.code, true, failure.missing ? { missing: failure.missing } : {})
        void close({ graceMs: 0 })
        return
      }
    }
    // A conversation that failed the gate shows nothing more from it.
    if (gateError) { stats.droppedAfterGate++; return }
    stats.messages++
    safeCall(onMessage, msg)
  }

  function handleOversized(prefix) {
    stats.oversized++
    notice('CLAUDE_LINE_TOO_LONG', false)
    // [추정] The CLI writes `type` then `request_id` first; answering keeps it from waiting forever.
    if (/^\s*\{\s*"type"\s*:\s*"control_request"/.test(prefix)) {
      const match = /"request_id"\s*:\s*"([^"\\]{1,300})"/.exec(prefix)
      if (match) { try { writeLine(controlError(match[1], 'Request too large for EG-Desk')) } catch {} }
    }
  }

  const stdoutFramer = createLineFramer({
    maxLineChars: L.maxLineChars,
    onLine: line => { try { handleLine(line) } catch { stats.handlerErrors++ } },
    onOversized: handleOversized,
  })
  const stderrFramer = createLineFramer({
    maxLineChars: L.maxStderrLineChars,
    onLine: line => {
      if (!line.trim()) return
      stats.stderrLines++
      safeCall(onStderr, publicText(line, L.maxStderrLineChars))
    },
    onOversized: prefix => { stats.stderrLines++; safeCall(onStderr, publicText(prefix, L.maxStderrLineChars)) },
  })

  function finalize(code, signal) {
    if (finalized) return
    clearTimeout(exitFallbackTimer)
    const tail = stdoutFramer.flush()
    if (tail.trim()) { try { handleLine(tail) } catch { stats.handlerErrors++ } }
    finalized = true
    state = 'exited'
    stdinWritable = false
    if (!exitInfo) exitInfo = { code: code ?? null, signal: signal ?? null }
    for (const done of exitWaiters) done()
    exitWaiters.clear()
    if (child && ACTIVE.has(child)) ACTIVE.delete(child)
    rejectOutgoing(transportError('CLAUDE_TRANSPORT_CLOSED', 'Claude exited', { exitCode: exitInfo.code, signal: exitInfo.signal }))
    for (const [requestId, entry] of incoming) {
      entry.abort.abort()
      safeCall(onControlCancel, requestId, entry.subtype, 'exit')
    }
    incoming.clear()
    resolveFinalized()
    safeCall(onExit, { code: exitInfo.code, signal: exitInfo.signal, reason: gateError ? 'gate' : closeRequested ? 'closed' : 'exited' })
  }

  function waitExit(ms) {
    if (exitInfo || finalized) return Promise.resolve(true)
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); resolve(true) }
      const timer = setTimeout(() => { exitWaiters.delete(done); resolve(false) }, Math.max(0, ms))
      timer.unref?.()
      exitWaiters.add(done)
    })
  }

  function probeVersion(childEnv) {
    return new Promise(resolve => {
      try {
        // A passive probe must not update the user's installation (same rule as claude-engine-auth).
        execFileImpl(executablePath, ['--version'], {
          env: { ...childEnv, DISABLE_AUTOUPDATER: '1' }, timeout: T.versionProbeMs, shell: false, windowsHide: true, maxBuffer: 64 * 1024,
        }, (error, stdout) => resolve(error ? null : String(stdout ?? '')))
      } catch { resolve(null) }
    })
  }

  async function start() {
    if (state !== 'idle') throw transportError('CLAUDE_TRANSPORT_STATE', 'This Claude transport was already started')
    state = 'starting'
    let spawnedOk = false
    try {
      if (typeof executablePath !== 'string' || !executablePath || executablePath.includes('\0') || !isAbsoluteFor(platform, executablePath)) {
        throw transportError('CLAUDE_EXECUTABLE_INVALID', 'The Claude executable path must be absolute')
      }
      if (platform === 'win32' && isWindowsBatchPath(executablePath)) {
        throw transportError('CLAUDE_EXECUTABLE_BATCH_REFUSED', 'A .bat/.cmd Claude launcher cannot be run safely; use the native claude.exe')
      }
      if (cwd != null) absolutePath(cwd, 'cwd', platform)
      // D-S4: stop before anything runs, the probe included.
      const detected = detectApiKeyEnv(env, { platform })
      if (detected.length && apiKeyEnvPolicy === 'stop') {
        throw transportError('CLAUDE_API_KEY_DETECTED', 'An Anthropic API key is set in the environment; confirm before Claude starts', { detected })
      }
      managed = managedMcpConfig ?? (() => { try { return Boolean(existsImpl(managedMcpConfigPath(platform))) } catch { return false } })()
      const args = buildClaudeArgs({ ...options, managedMcpConfig: managed, platform })
      const childEnv = buildClaudeEnv(env, { platform, cwd, claudeConfigDir, inheritEnvNames, extraEnv })
      const versionText = typeof version === 'string' ? version : await probeVersion(childEnv)
      if (state !== 'starting') throw transportError('CLAUDE_TRANSPORT_CLOSED', 'Closed while starting')
      const gate = checkClaudeVersion(versionText, minVersion)
      if (!gate.ok) {
        throw transportError(gate.code, gate.version ? `Claude ${gate.version} is older than ${minVersion}` : 'Could not read the Claude version', { version: gate.version, minVersion })
      }
      probedVersion = gate.version
      if (managed) notice('CLAUDE_MANAGED_MCP_CONFIG', false)

      let spawned
      try {
        spawned = spawnImpl(executablePath, args, {
          cwd: cwd ?? undefined, env: childEnv, shell: false, windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'], detached: processGroup,
        })
      } catch (error) {
        throw transportError('CLAUDE_SPAWN_FAILED', 'Claude could not be started', { cause: error?.code || null })
      }
      child = spawned
      await new Promise((resolve, reject) => {
        const onSpawn = () => { child.off('error', onError); resolve() }
        const onError = error => {
          child.off('spawn', onSpawn)
          reject(error?.code === 'ENOENT'
            ? transportError('CLAUDE_NOT_FOUND', 'Claude was not found at the given path')
            : transportError('CLAUDE_SPAWN_FAILED', 'Claude could not be started', { cause: error?.code || null }))
        }
        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
      spawnedOk = true
      child.on('error', () => {}) // late errors (kill on a dead pid) must not crash the helper
      ACTIVE.set(child, killChild)
      installReaper()
      stdinWritable = true
      child.stdin.on('error', () => { stdinWritable = false; stats.writeFailures++ })
      child.stdin.on('close', () => { stdinWritable = false })
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => stdoutFramer.push(chunk))
      child.stdout.on('error', () => {})
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => stderrFramer.push(chunk))
      child.stderr.on('error', () => {})
      child.on('exit', (code, signal) => {
        if (!exitInfo) exitInfo = { code: code ?? null, signal: signal ?? null }
        for (const done of exitWaiters) done()
        exitWaiters.clear()
        if (ACTIVE.has(child)) ACTIVE.delete(child)
        exitFallbackTimer = setTimeout(() => {
          try { child.stdout.destroy() } catch {}
          try { child.stderr.destroy() } catch {}
          finalize(code, signal)
        }, T.exitCloseFallbackMs)
        exitFallbackTimer.unref?.()
      })
      child.on('close', (code, signal) => finalize(code, signal))
      if (state !== 'starting') throw transportError('CLAUDE_TRANSPORT_CLOSED', 'Closed while starting')
      state = 'running'

      let initializeResponse = null
      if (initialize !== false) {
        const extra = plainObject(initialize) || {}
        const fields = { hooks: null }
        if (plainObject(extra.agents)) fields.agents = extra.agents
        if (typeof extra.forwardSubagentText === 'boolean') fields.forwardSubagentText = extra.forwardSubagentText
        if (typeof extra.excludeDynamicSections === 'boolean') fields.excludeDynamicSections = extra.excludeDynamicSections
        initializeResponse = await request('initialize', fields, { timeoutMs: T.initializeMs })
      }
      initialized = true
      return { pid: child.pid ?? null, version: probedVersion, managedMcpConfig: managed, initialize: initializeResponse }
    } catch (error) {
      if (child && spawnedOk && !finalized) await close({ graceMs: 0 }).catch(() => {})
      else if (!spawnedOk) {
        // Never ran (refused before spawn, or the spawn itself failed): nothing to stop.
        state = 'exited'
        stdinWritable = false
        for (const stream of [child?.stdin, child?.stdout, child?.stderr]) { try { stream?.destroy() } catch {} }
        child = null
      }
      throw error
    }
  }

  function sendUserMessage(content, { parentToolUseId = null } = {}) {
    if (state !== 'running' || !initialized) throw transportError('CLAUDE_TRANSPORT_STATE', 'Claude is not ready for a message')
    const validText = typeof content === 'string' && content.length > 0
    const validBlocks = Array.isArray(content) && content.length > 0 && content.length <= L.maxContentBlocks &&
      content.every(block => plainObject(block) && typeof block.type === 'string')
    if (!validText && !validBlocks) throw optionError('content must be text or an array of content blocks')
    if (parentToolUseId !== null && !idText(parentToolUseId)) throw optionError('parentToolUseId must be null or an id')
    // Same line the SDK writes for a prompt (client.py:184-189).
    const written = writeLine({ type: 'user', session_id: '', message: { role: 'user', content }, parent_tool_use_id: parentToolUseId })
    if (!written) throw transportError('CLAUDE_WRITE_FAILED', 'Claude input is closed')
    return true
  }

  function endInput() {
    if (!child || !stdinWritable) return
    stdinWritable = false
    try { child.stdin.end() } catch {}
  }

  /**
   * Stop the process: pending outgoing requests are rejected, stdin is
   * closed (the CLI flushes its session file on EOF), then SIGTERM after
   * graceMs and SIGKILL after termMs (process group on POSIX). Resolves
   * { code, signal, forced: null | 'term' | 'kill' }.
   */
  function close({ graceMs = T.closeGraceMs, termMs = T.closeTermMs, killMs = T.closeKillMs } = {}) {
    if (closePromise) return closePromise
    closeRequested = true
    if (!child) {
      state = 'exited'
      closePromise = Promise.resolve({ code: null, signal: null, forced: null })
      return closePromise
    }
    if (!finalized) state = 'closing'
    closePromise = (async () => {
      rejectOutgoing(transportError('CLAUDE_TRANSPORT_CLOSED', 'Claude transport closed'))
      endInput()
      let forced = null
      if (!(await waitExit(graceMs))) {
        forced = 'term'
        killChild('SIGTERM')
        if (!(await waitExit(termMs))) {
          forced = 'kill'
          killChild('SIGKILL')
          await waitExit(killMs)
        }
      }
      if (!finalized) {
        const settled = await Promise.race([
          finalizedPromise.then(() => true),
          new Promise(resolve => { const t = setTimeout(() => resolve(false), T.exitCloseFallbackMs + 100); t.unref?.() }),
        ])
        if (!settled) finalize(exitInfo?.code ?? null, exitInfo?.signal ?? null)
      }
      return { code: exitInfo?.code ?? null, signal: exitInfo?.signal ?? null, forced }
    })()
    return closePromise
  }

  return {
    start,
    sendUserMessage,
    /** Ask the CLI to stop the current turn (it still writes a result). */
    interrupt: ({ timeoutMs = T.interruptMs } = {}) => request('interrupt', {}, { timeoutMs }),
    setPermissionMode: mode => {
      if (!CLAUDE_PERMISSION_MODES.includes(mode)) return Promise.reject(optionError('Unsupported permission mode'))
      return request('set_permission_mode', { mode })
    },
    setModel: model => {
      if (model !== null && (typeof model !== 'string' || !MODEL.test(model))) return Promise.reject(optionError('model must be a model id, alias or null'))
      return request('set_model', { model })
    },
    request,
    respondControl,
    endInput,
    close,
    state: () => state,
    info: () => ({
      state, pid: child?.pid ?? null, version: probedVersion, managedMcpConfig: managed,
      init: initInfo ? { ...initInfo, capabilities: [...initInfo.capabilities] } : null,
      pendingIncoming: incoming.size, pendingOutgoing: outgoing.size,
      exit: exitInfo ? { ...exitInfo } : null,
    }),
    stats: () => ({ ...stats }),
  }
}
