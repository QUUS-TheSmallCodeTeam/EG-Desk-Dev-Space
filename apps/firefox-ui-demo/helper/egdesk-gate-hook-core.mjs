import { classifyCommand } from './egdesk-terminal-command-gate.mjs'
import { gateNote } from './egdesk-gate-hook-broker.mjs'

// The PreToolUse hook's logic (the script scripts/egdesk-codex-gate-hook.mjs is a thin stdin/stdout wrapper). Input shape from the
// official hooks reference (https://learn.chatgpt.com/docs/hooks, "Common input fields" and "PreToolUse"): session_id, cwd,
// hook_event_name, turn_id, tool_name ('Bash' for shell commands and unified exec), tool_use_id, tool_input.command.
// Output: exit 0 and nothing (Codex continues, the engine's own sandbox and approvals still apply), or the documented deny shape.
// The hook never allows past Codex's own approvals (it has no "allow" output at all: allowing means saying nothing).
//
// It acts only for an engine EG-Desk started: EGDESK_GATE_HOOK_URL and EGDESK_GATE_HOOK_TOKEN are set in that app-server's
// environment. Without them (the person's own Codex CLI using the same hooks file) it says nothing and asks nothing.
// Bridge down (unreachable, timeout, bad answer): a FLOOR command is denied (fail closed) and everything else passes silently.
//   Why: a floor command is one whose effect cannot be undone; a wrong deny costs one turn (the model tells the person), a wrong
//   pass cannot be taken back. For the rest, the predicates need the bridge; failing closed on every command would stop all work
//   whenever the bridge is away, which is not today's behaviour (P2).
export const GATE_HOOK_TIMEOUT_MS = 5000 // the bridge may judge with the predicates (<= 4 s foreground deadline)

export function hookCommandText(input) {
  const raw = input?.tool_input?.command
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && raw.every(part => typeof part === 'string')) {
    if (raw.length === 3 && /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh$/.test(raw[0]) && /^-l?c$/.test(raw[1])) return raw[2]
    return raw.map(part => (/^[\w@%+=:,./-]+$/.test(part) ? part : `'${part.replace(/'/g, `'\\''`)}'`)).join(' ')
  }
  return null
}
const deny = reason => ({ exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }) })
const silent = () => ({ exitCode: 0, stdout: '' })

export async function runGateHook({ stdin, env = {}, fetchImpl = globalThis.fetch, home = env.HOME, timeoutMs = GATE_HOOK_TIMEOUT_MS }) {
  let input
  try { input = JSON.parse(stdin) } catch { return silent() }
  if (input?.hook_event_name !== 'PreToolUse' || input?.tool_name !== 'Bash') return silent()
  const url = env.EGDESK_GATE_HOOK_URL, token = env.EGDESK_GATE_HOOK_TOKEN
  if (typeof url !== 'string' || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]|localhost):\d+\//.test(url) || typeof token !== 'string' || token.length < 16) return silent()
  const command = hookCommandText(input)
  const cwd = typeof input.cwd === 'string' ? input.cwd : null
  if (!command || !cwd) return silent()
  const floor = classifyCommand(command, { cwd, home }).floor
  let answer = null
  try {
    const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ session_id: input.session_id ?? null, turn_id: input.turn_id ?? null, cwd, command }), signal: AbortSignal.timeout(timeoutMs) })
    if (response.ok) answer = await response.json()
  } catch { answer = null }
  const decision = answer?.decision
  if (decision === 'deny' && typeof answer.note === 'string') return deny(answer.note.slice(0, 2000))
  if (decision === 'allow' || decision === 'none') return silent()
  // no usable answer from the bridge
  return floor.length ? deny(gateNote({ status: 'gate_unavailable', reasons: floor, next: 'tell_user_and_stop' })) : silent()
}
