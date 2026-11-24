import { execFile as nodeExecFile } from 'node:child_process'
import { lstat as nodeLstat } from 'node:fs/promises'
import path from 'node:path'

// Read-only facts about a command's targets for the command gate (egdesk-terminal-command-gate.mjs): does the target
// exist, how many tracked files are under it, is it ignored, is the worktree dirty. Nothing is written: `git` is run
// without a shell, with optional locks off and no prompt, bounded in time and output; a failure only means "unknown".
// Targets outside the working directory are not looked at (the gate's rules already require approval for those).
export const GIT_FACTS_LIMITS = Object.freeze({ paths: 8, timeoutMs: 1500, maxBuffer: 1024 * 1024 })
const ENV = Object.freeze({ GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' })

/**
 * createGitTargetInspector({ execFile?, lstat?, env?, limits? }) → async ({ cwd, paths }) → { targets: { [absPath]: info }, git: { dirty } | null }
 *   info: { exists, kind: 'dir'|'file'|'other'|null, trackedFiles, ignored } or { ..., unknown: true } when git could not answer
 */
export function createGitTargetInspector({ execFile = nodeExecFile, lstat = nodeLstat, env = process.env, limits = {} } = {}) {
  const max = { ...GIT_FACTS_LIMITS, ...limits }
  const git = (cwd, args) => new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { timeout: max.timeoutMs, maxBuffer: max.maxBuffer, windowsHide: true, env: { PATH: env.PATH ?? '', HOME: env.HOME ?? '', ...ENV } },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout ?? ''))))
  })
  return async function inspect({ cwd, paths } = {}) {
    const targets = {}
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { targets, git: null }
    const list = (Array.isArray(paths) ? paths : []).filter(p => typeof p === 'string' && (p === cwd || p.startsWith(cwd + path.sep))).slice(0, max.paths)
    let repo = true
    try { await git(cwd, ['rev-parse', '--is-inside-work-tree']) } catch { repo = false }
    for (const target of list) {
      let exists = false, kind = null
      try { const stat = await lstat(target); exists = true; kind = stat.isDirectory() ? 'dir' : stat.isFile() ? 'file' : 'other' } catch { exists = false }
      if (!repo) { targets[target] = { exists, kind, trackedFiles: 0, ignored: false, unknown: true }; continue }
      try {
        let trackedFiles
        try { trackedFiles = (await git(cwd, ['ls-files', '-z', '--', target])).split('\0').filter(Boolean).length }
        catch (error) { if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') trackedFiles = 9999; else throw error }
        let ignored = false
        try { await git(cwd, ['check-ignore', '-q', '--', target]); ignored = true } catch (error) { if (error?.code !== 1) throw error }
        targets[target] = { exists, kind, trackedFiles, ignored }
      } catch { targets[target] = { exists, kind, trackedFiles: 0, ignored: false, unknown: true } }
    }
    let dirty = null
    if (repo) { try { dirty = (await git(cwd, ['status', '--porcelain', '--untracked-files=no', '-z'])).length > 0 } catch { dirty = null } }
    return { targets, git: dirty === null ? null : { dirty } }
  }
}
