// u1 (PHILOSOPHY U19): a Claude conversation runs under EG-Desk's harness, the same one the Codex engine runs under (own tools: EG-Desk's runner and file tools as the engine's only shell, its
// approvals, its decision-model turn judgements). Developer flag EGDESK_CLAUDE_HARNESS=on (default off; it needs EGDESK_OWN_TOOLS=on, the flag that creates EG-Desk's tools at all).
//
// What the flag does for engine 'claude', and nothing else:
//   1. EG-Desk's own command and file tools (egdesk_run_command, egdesk_read_file, egdesk_search_files, egdesk_edit_file, egdesk_undo_edit; tool names are provisional) are offered through the
//      adapter's in-process MCP server. The approvals and policies are EG-Desk's own path, the one Codex uses: rule floor, then the yes/no predicates, then the person's one-time approval of the
//      exact command in the conversation (the gate ledger). Nothing here re-implements them.
//   2. Claude Code's built-in tools that do the same work are switched off with `--disallowedTools` (Bash, Edit, Write, MultiEdit, NotebookEdit; and the ones that run commands or reach outside the
//      conversation through another door: Monitor, Workflow, worktrees, messages, notifications, remote triggers, scheduled runs): a command or a file change can only go through
//      EG-Desk's tools. The Claude Code binary is not touched (flags, MCP and settings only). WebFetch and WebSearch stay as they are unless EG-Desk's browser tools are on (EGDESK_PAGE_TOOLS=on: the cards
//      are then the way to read and drive a page) or EGDESK_CLAUDE_HARNESS_WEB=off says so.
//   3. The thread runs in EG-Desk's empty engine folder, like Codex's own-tools thread; the person's real folder is known to EG-Desk's tools only.
//   4. EG-Desk's developer instructions tell the model its own shell and editor are off and how to read a tool result that needs the person.
// Pure: no I/O.
import { OWN_TOOLS_INSTRUCTIONS } from './egdesk-own-tools-isolation.mjs'

export const CLAUDE_HARNESS_FLAG = 'EGDESK_CLAUDE_HARNESS'
export const CLAUDE_HARNESS_WEB_FLAG = 'EGDESK_CLAUDE_HARNESS_WEB'
/** The Browser lane's flag (u1: EG-Desk's card tools egdesk_card_read / _press / _type / _open): when they are on, the built-in web tools are off, so a page is read and driven only through EG-Desk's cards. */
export const EGDESK_PAGE_TOOLS_FLAG = 'EGDESK_PAGE_TOOLS'
/** EGDESK_CLAUDE_HARNESS_PRIVATE=on (default off): the runtime's private turns (draft revision, heartbeat writer, briefing fill) also run on Claude, on a fresh thread with no tools at all. Each costs a real Claude turn and leaves a CLI session file. */
export const CLAUDE_HARNESS_PRIVATE_FLAG = 'EGDESK_CLAUDE_HARNESS_PRIVATE'
/** The built-in Claude Code tools that run commands or change files: what EG-Desk's own tools replace. */
export const CLAUDE_BUILTIN_COMMAND_FILE_TOOLS = Object.freeze(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
/**
 * The built-in tools that read the project (u1b): EG-Desk's own egdesk_read_file and egdesk_search_files replace them, so the folder is read through EG-Desk's one door. What EG-Desk's tools do not cover (reported):
 * listing or globbing files by NAME (egdesk_search_files matches file CONTENT; use a read-only command through egdesk_run_command, e.g. ls or find), reading images, PDFs and notebooks (egdesk_read_file is text only: a
 * binary file is described), and Grep's output modes and context lines.
 */
export const CLAUDE_BUILTIN_READ_TOOLS = Object.freeze(['Read', 'Grep', 'Glob'])

/**
 * Built-in tools that run commands or change the machine through another door, or reach outside the conversation (messages, notifications, remote triggers, scheduled or unattended runs, worktrees):
 * an EG-Desk conversation does that only through EG-Desk's own tools and the person's own approval, so they are off under the harness too. Names as the CLI lists them (a name this CLI version does not have is
 * harmless in --disallowedTools). Read, Grep, Glob, ListAgents, ToolSearch, TaskStop, the plan-mode tools, ReportFindings and DesignSync stay: they read, or only steer this one conversation.
 */
export const CLAUDE_BUILTIN_OUTWARD_TOOLS = Object.freeze(['Monitor', 'Workflow', 'EnterWorktree', 'ExitWorktree', 'SendMessage', 'SendToProject', 'PushNotification', 'RemoteTrigger', 'CronCreate', 'CronDelete', 'CronList', 'ScheduleWakeup', 'SendToProjectContext', 'DesignSync'])

/**
 * u2 (D5): tools that move work or the conversation's flow outside EG-Desk.
 *   Agent (and its old name Task), ListAgents: a sub-agent runs its own tools and its messages are withheld from EG-Desk (the translator keeps one row per call only), so its work is outside the harness.
 *   EnterPlanMode, ExitPlanMode: a plan mode is the CLI's own flow, and the approval it asks for (a tool that is not a command, a file change or a question) is refused by EG-Desk's permission broker: a conversation
 *   that entered plan mode could not leave it.
 * Kept on purpose: AskUserQuestion (EG-Desk answers it: the broker turns it into the conversation's own question card and returns the person's answer), ToolSearch (the fallback that still reaches the EG-Desk
 * tools if the CLI ever defers them: switching it off could make them unreachable), TaskStop (stops a task of this conversation), ReportFindings (no outward effect documented: it hands structured findings back to the
 * session; not verified), Read/Grep/Glob are off for another reason (above).
 */
export const CLAUDE_BUILTIN_FLOW_TOOLS = Object.freeze(['Agent', 'Task', 'ListAgents', 'EnterPlanMode', 'ExitPlanMode'])

/**
 * Claude Code's own computer-use MCP server (documented 2026-11 for macOS, an interactive session feature, not available with -p). It is not in the --mcp-config EG-Desk gives (the CLI is started with
 * --strict-mcp-config and only EG-Desk's own server), so it should not be there; the rule below blocks every tool of a server by this name too (both spellings), so a computer is driven only by EG-Desk's own
 * computer tools (egdesk_computer_*), never by the CLI's.
 */
export const CLAUDE_BUILTIN_COMPUTER_USE_RULES = Object.freeze(['mcp__computer-use', 'mcp__computer_use'])

/** The built-in web tools: left on by default; the Browser lane's decision, one switch away. */
export const CLAUDE_BUILTIN_WEB_TOOLS = Object.freeze(['WebFetch', 'WebSearch'])
export const CLAUDE_HARNESS_ACTIVITY = 'egdesk-tool'

/** → { disallowed: [...] } or null (off). Anything but 'on' is off. */
export function claudeHarnessFromEnv(env = {}) {
  if (env?.[CLAUDE_HARNESS_FLAG] !== 'on') return null
  return Object.freeze({ privateTurns: env?.EGDESK_CLAUDE_HARNESS_PRIVATE === 'on', disallowed: Object.freeze([...CLAUDE_BUILTIN_COMMAND_FILE_TOOLS, ...CLAUDE_BUILTIN_READ_TOOLS, ...CLAUDE_BUILTIN_OUTWARD_TOOLS, ...CLAUDE_BUILTIN_FLOW_TOOLS, ...CLAUDE_BUILTIN_COMPUTER_USE_RULES, ...(env?.[CLAUDE_HARNESS_WEB_FLAG] === 'off' || env?.[EGDESK_PAGE_TOOLS_FLAG] === 'on' ? CLAUDE_BUILTIN_WEB_TOOLS : [])]) })
}

const FIRST_SENTENCE = /^Your own shell and patch tools are off in this session[^\n]*\n?/
/** Codex's own-tools block, said for Claude: its own shell and editor are off, EG-Desk's tools are the way. The rest of the block is the same words. */
export function claudeHarnessInstructions(base) {
  const rest = OWN_TOOLS_INSTRUCTIONS.replace(FIRST_SENTENCE, '')
  const own = ['Your own shell, file-editing and file-reading tools (Bash, Edit, Write, MultiEdit, NotebookEdit, Read, Grep, Glob) are off in this session. The egdesk tools below reach you as mcp__egdesk__<name>; the names in this text are the part after the last double underscore.', rest, 'To list files by name, run a read-only command such as ls or find with egdesk_run_command.'].join('\n')
  const person = typeof base === 'string' && base.trim() ? base.trim() : ''
  const memory = 'EG-Desk, not you, keeps the person\'s memory and standing instructions: it holds them in a guidance record the person can apply or revert, and it carries what matters into your turns (a line from EG-Desk in a turn says where an instruction stands, when there is one). When the person asks you to remember something or to change how you answer (shorter, another tone), do it from this turn on. Do not say that you saved it to your own memory, and do not say that you cannot keep anything; do not add to or contradict the state EG-Desk gives you.'
  return person ? `${person}\n\n${own}\n\n${memory}` : `${own}\n\n${memory}`
}

/** The thread overrides of a Claude harness thread: instructions and the built-in tools to switch off. */
export function claudeHarnessThreadOverrides({ base = null, harness } = {}) {
  if (!harness) return {}
  return { developerInstructions: claudeHarnessInstructions(base), egdeskDisallowedTools: [...harness.disallowed], egdeskAlwaysLoad: true }
}
