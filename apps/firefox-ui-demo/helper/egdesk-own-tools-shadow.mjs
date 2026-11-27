import path from 'node:path'
import { classifyCommand } from './egdesk-terminal-command-gate.mjs'
import { executorAssess } from './egdesk-command-executor.mjs'
import { resolveTarget } from './egdesk-file-tools.mjs'

// SHADOW of EG-Desk's own tools (c20; developer flag EGDESK_OWN_TOOLS=shadow, default off). Codex keeps its own shell and file
// changes exactly as today; for every command and file change it starts, EG-Desk only works out what its own command tool and file
// rules WOULD have done, and records that in closed words (calibration log feature own_tools_shadow). Nothing is answered, blocked,
// shown or sent to the engine; no command text, path or content is written. It measures the first real use before switching.
//   would_run     the own tools would have run it without asking
//   would_ask     they would have asked the person first (rule floor, predicates, unjudged change, a whole-file delete of a kept file)
//   would_refuse  they would have refused it (outside the run folder, a protected path, a link that leads out)
export const SHADOW_WOULD = Object.freeze(['would_run', 'would_ask', 'would_refuse'])
const FILE_CODES = Object.freeze({ FILE_OUTSIDE_FOLDER: 'outside_folder', FILE_PROTECTED: 'protected_path', FILE_SYMLINK_ESCAPE: 'symlink_escape', FILE_SYMLINK: 'symlink',
  FILE_PATH_INVALID: 'invalid_path', FILE_UNREADABLE: 'invalid_path' })
export const SHADOW_REASONS = Object.freeze(['no_folder', 'outside_folder', 'protected_path', 'symlink_escape', 'symlink', 'invalid_path', 'kept_file_delete'])
const inside = (root, target) => target === root || target.startsWith(`${root}${path.sep}`)

/** What the command tool would do with a command Codex ran (assess: the runtime's predicate judgement, or null). */
export async function shadowCommand({ command, cwd = null, root, home, assess = null, conversationId = null, turnId = null }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return { subject: 'command', would: 'would_refuse', reasons: ['no_folder'] }
  const where = typeof cwd === 'string' && path.isAbsolute(cwd) ? path.resolve(cwd) : root
  if (!inside(root, where)) return { subject: 'command', would: 'would_refuse', reasons: ['outside_folder'] }
  const floor = classifyCommand(command, { cwd: where, home }).floor
  if (floor.length) return { subject: 'command', would: 'would_ask', reasons: floor }
  const assessed = await executorAssess(assess, { home })({ command, cwd: where, conversationId, turnId })
  return assessed?.approval === true ? { subject: 'command', would: 'would_ask', reasons: assessed.reasons ?? ['risk_unsure'] } : { subject: 'command', would: 'would_run', reasons: [] }
}

/** What the file rules would do with one change Codex made (kind add | update | delete). */
export async function shadowFileChange({ filePath, kind, root, inspect = null }) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) return { subject: 'file_change', fileKind: kind, would: 'would_refuse', reasons: ['no_folder'] }
  const relative = typeof filePath === 'string' && path.isAbsolute(filePath) ? path.relative(root, filePath) : filePath
  let r
  try { r = await resolveTarget(root, relative || '', { write: true }) } catch { r = { error: 'FILE_PATH_INVALID' } }
  if (r.error) return { subject: 'file_change', fileKind: kind, would: 'would_refuse', reasons: [FILE_CODES[r.error] ?? 'invalid_path'] }
  if (kind !== 'delete') return { subject: 'file_change', fileKind: kind, would: 'would_run', reasons: [] } // a create or a diff: shown and undoable
  let generated = false
  try { const t = typeof inspect === 'function' ? (await inspect({ cwd: r.root, paths: [r.target] }))?.targets?.[r.target] : null; generated = t?.ignored === true && t?.trackedFiles === 0 } catch { generated = false }
  return generated ? { subject: 'file_change', fileKind: kind, would: 'would_run', reasons: [] } : { subject: 'file_change', fileKind: kind, would: 'would_ask', reasons: ['kept_file_delete'] }
}
