// Deleting the files Claude Code keeps for ONE conversation EG-Desk started (L2 c19; owner decision "delete the records", developer flag
// EGDESK_CLAUDE_DELETE_SESSION, default off). Nothing here runs Claude; it removes named files under a Claude config directory.
//
// Source of every path: Anthropic's public Claude Code docs, checked 2026-11-25
//   https://code.claude.com/docs/en/sessions        "Where transcripts are stored"  (<config>/projects/<project>/<session-id>.jsonl,
//                                                    <project> = the working directory with non-alphanumerics -> "-", cut to 200 characters
//                                                    plus a hash when longer; CLAUDE_CONFIG_DIR moves <config>; default ~/.claude)
//   https://code.claude.com/docs/en/claude-directory "Application data" (the entries below that are keyed by <session>)
// The folder <project> is not derived here (a long path's hash is not specified): every folder directly under <config>/projects is looked in
// for the exact names of this one session id. `claude --resume <id>` also finds a session by id in any project folder (docs, "Resume by
// session ID or name"). The id is a UUID EG-Desk itself generated (claude-engine-adapter startThread) and recorded in the chat store.
//
// Removed, by exact name only, and never through a link:
//   projects/<project>/<id>.jsonl
//   projects/<project>/<id>.orphaned-<timestamp>-<suffix>.jsonl, <id>.jsonl.superseded-<timestamp>   (the session's set-aside transcripts)
//   projects/<project>/<id>/                                  (subagents, tool-results, mcp-tasks)
//   file-history/<id>/, image-cache/<id>/, uploads/<id>/, dev-mods/<id>/
// NOT removed (the docs key these by project or time, not by this session alone, or this source cannot prove them): history.jsonl prompt
// lines, projects/<project>/memory/ (auto memory), debug/, plans/, tasks/, session-env/, paste-cache/, the temp-directory scratchpad and
// images (claude-<uid>/<project>/<id>/..., CLAUDE_CODE_TMPDIR), and anything a cloud or desktop session kept elsewhere.
import { lstatSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const SESSION_DIRS = Object.freeze(['file-history', 'image-cache', 'uploads', 'dev-mods'])
const MAX_PROJECTS = 5000

/** The exact names that belong to one session inside one project folder. */
export function belongsToSession(name, sessionId) {
  return name === `${sessionId}.jsonl` || name === sessionId ||
    (name.startsWith(`${sessionId}.orphaned-`) && name.endsWith('.jsonl') && !name.includes('/') && !name.includes('\\')) ||
    name.startsWith(`${sessionId}.jsonl.superseded-`)
}

/**
 * deleteClaudeSessionFiles({ configDir, sessionId, recorded, uid? }) -> { state: 'deleted' | 'remains', files, reason? }
 *   configDir  absolute Claude config directory (CLAUDE_CONFIG_DIR, an owned profile's folder, or ~/.claude)
 *   sessionId  lowercase UUID; recorded: true only when EG-Desk's own record binds this id to the conversation (the caller checks)
 * state 'deleted': everything of this session that was found under the listed paths is gone (files may be 0: nothing was there).
 * state 'remains': something could not be removed or checked (reason: invalid | not_recorded | linked | not_owner | failed | too_many_projects).
 */
export function deleteClaudeSessionFiles({ configDir, sessionId, recorded = false, uid = typeof process.getuid === 'function' ? process.getuid() : null, platform = process.platform } = {}) {
  if (typeof sessionId !== 'string' || !UUID.test(sessionId) || typeof configDir !== 'string' || !(platform === 'win32' ? path.win32 : path.posix).isAbsolute(configDir) || configDir.includes('\0')) return { state: 'remains', files: 0, reason: 'invalid' }
  if (recorded !== true) return { state: 'remains', files: 0, reason: 'not_recorded' }
  let files = 0, reason = null
  const note = why => { reason ??= why }
  const stat = target => { try { return lstatSync(target) } catch (error) { return error?.code === 'ENOENT' ? null : (note('failed'), undefined) } }
  const mine = info => uid === null || info.uid === uid
  const remove = (target, info) => {
    if (info.isSymbolicLink()) return note('linked')
    if (!mine(info)) return note('not_owner')
    try { rmSync(target, { recursive: info.isDirectory(), force: false }); files++ } catch { note('failed') }
  }
  const config = stat(configDir)
  if (config === undefined) return { state: 'remains', files, reason }
  if (config === null) return { state: 'deleted', files: 0 } // no Claude data at all
  if (!config.isDirectory() || config.isSymbolicLink()) return { state: 'remains', files: 0, reason: 'linked' }
  const projects = path.join(configDir, 'projects'), top = stat(projects)
  if (top && (!top.isDirectory() || top.isSymbolicLink())) note('linked')
  else if (top) {
    let names = []
    try { names = readdirSync(projects) } catch { note('failed') }
    if (names.length > MAX_PROJECTS) note('too_many_projects')
    else for (const project of names) {
      const folder = path.join(projects, project), info = stat(folder)
      if (!info || !info.isDirectory() || info.isSymbolicLink()) continue // a file or a link in projects/ is not a project folder
      let entries = []
      try { entries = readdirSync(folder) } catch { note('failed'); continue }
      for (const name of entries) {
        if (!belongsToSession(name, sessionId)) continue
        const target = path.join(folder, name), entry = stat(target)
        if (entry) remove(target, entry)
      }
    }
  }
  for (const dir of SESSION_DIRS) {
    const target = path.join(configDir, dir, sessionId), entry = stat(target)
    if (entry) remove(target, entry)
  }
  return reason ? { state: 'remains', files, reason } : { state: 'deleted', files }
}
