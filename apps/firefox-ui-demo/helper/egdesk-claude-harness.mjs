// u1 (PHILOSOPHY U19): a Claude conversation runs under EG-Desk's harness, the same one the Codex engine runs under (own tools: EG-Desk's runner and file tools as the engine's only shell, its
// approvals, its decision-model turn judgements). Developer flag EGDESK_CLAUDE_HARNESS=on (default off; it needs EGDESK_OWN_TOOLS=on, the flag that creates EG-Desk's tools at all).
//
// What the flag does for engine 'claude', and nothing else:
//   1. EG-Desk's own command and file tools (egdesk_run_command, egdesk_read_file, egdesk_search_files, egdesk_edit_file, egdesk_undo_edit; tool names are provisional) are offered through the
//      adapter's in-process MCP server. The approvals and policies are EG-Desk's own path, the one Codex uses: rule floor, then the yes/no predicates, then the person's one-time approval of the
//      exact command in the conversation (the gate ledger). Nothing here re-implements them.
//   2. Claude Code's built-in tools that do the same work are switched off with `--disallowedTools` (Bash, Edit, Write, MultiEdit, NotebookEdit; and the ones that run commands or reach outside the
//      conversation through another door: Monitor, Workflow, worktrees, messages, notifications, remote triggers, scheduled runs): a command or a file change can only go through
//      EG-Desk's tools. The Claude Code binary is not touched (flags, MCP and settings only). WebFetch and WebSearch stay as they are unless EGDESK_CLAUDE_HARNESS_WEB=off adds them (the Browser
//      lane decides what replaces them: nothing here guesses).
//   3. The thread runs in EG-Desk's empty engine folder, like Codex's own-tools thread; the person's real folder is known to EG-Desk's tools only.
//   4. EG-Desk's developer instructions tell the model its own shell and editor are off and how to read a tool result that needs the person.
// Pure: no I/O.
import { OWN_TOOLS_INSTRUCTIONS } from './egdesk-own-tools-isolation.mjs'

export const CLAUDE_HARNESS_FLAG = 'EGDESK_CLAUDE_HARNESS'
export const CLAUDE_HARNESS_WEB_FLAG = 'EGDESK_CLAUDE_HARNESS_WEB'
/** EGDESK_CLAUDE_HARNESS_PRIVATE=on (default off): the runtime's private turns (draft revision, heartbeat writer, briefing fill) also run on Claude, on a fresh thread with no tools at all. Each costs a real Claude turn and leaves a CLI session file. */
export const CLAUDE_HARNESS_PRIVATE_FLAG = 'EGDESK_CLAUDE_HARNESS_PRIVATE'
/** The built-in Claude Code tools that run commands or change files: what EG-Desk's own tools replace. */
export const CLAUDE_BUILTIN_COMMAND_FILE_TOOLS = Object.freeze(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/**
 * Built-in tools that run commands or change the machine through another door, or reach outside the conversation (messages, notifications, remote triggers, scheduled or unattended runs, worktrees):
 * an EG-Desk conversation does that only through EG-Desk's own tools and the person's own approval, so they are off under the harness too. Names as the CLI lists them (a name this CLI version does not have is
 * harmless in --disallowedTools). Read, Grep, Glob, ListAgents, ToolSearch, TaskStop, the plan-mode tools, ReportFindings and DesignSync stay: they read, or only steer this one conversation.
 */
export const CLAUDE_BUILTIN_OUTWARD_TOOLS = Object.freeze(['Monitor', 'Workflow', 'EnterWorktree', 'ExitWorktree', 'SendMessage', 'SendToProject', 'PushNotification', 'RemoteTrigger', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup'])

/** The built-in web tools: left on by default; the Browser lane's decision, one switch away. */
export const CLAUDE_BUILTIN_WEB_TOOLS = Object.freeze(['WebFetch', 'WebSearch'])
export const CLAUDE_HARNESS_ACTIVITY = 'egdesk-tool'

/** → { disallowed: [...] } or null (off). Anything but 'on' is off. */
export function claudeHarnessFromEnv(env = {}) {
  if (env?.[CLAUDE_HARNESS_FLAG] !== 'on') return null
  return Object.freeze({ privateTurns: env?.EGDESK_CLAUDE_HARNESS_PRIVATE === 'on', disallowed: Object.freeze([...CLAUDE_BUILTIN_COMMAND_FILE_TOOLS, ...CLAUDE_BUILTIN_OUTWARD_TOOLS, ...(env?.[CLAUDE_HARNESS_WEB_FLAG] === 'off' ? CLAUDE_BUILTIN_WEB_TOOLS : [])]) })
}

const FIRST_SENTENCE = /^Your own shell and patch tools are off in this session[^\n]*\n?/
/** Codex's own-tools block, said for Claude: its own shell and editor are off, EG-Desk's tools are the way. The rest of the block is the same words. */
export function claudeHarnessInstructions(base) {
  const rest = OWN_TOOLS_INSTRUCTIONS.replace(FIRST_SENTENCE, '')
  const own = ['Your own shell and file-editing tools (Bash, Edit, Write, MultiEdit, NotebookEdit) are off in this session. The egdesk tools below reach you as mcp__egdesk__<name>; the names in this text are the part after the last double underscore.', rest].join('\n')
  const person = typeof base === 'string' && base.trim() ? base.trim() : ''
  return person ? `${person}\n\n${own}` : own
}

/** The thread overrides of a Claude harness thread: instructions and the built-in tools to switch off. */
export function claudeHarnessThreadOverrides({ base = null, harness } = {}) {
  if (!harness) return {}
  return { developerInstructions: claudeHarnessInstructions(base), egdeskDisallowedTools: [...harness.disallowed] }
}
